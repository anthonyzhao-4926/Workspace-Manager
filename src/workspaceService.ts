import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectInfo, ProjectListResult, ProjectScanCache, WorkspaceFolderEntry, WorkspaceInfo } from "./types";

const CONFIG_SECTION = "cursorWorkspace";
const PROJECT_CACHE_KEY = "cursorWorkspace.projectScanCache";

/**
 * Workspace 文件读写、项目扫描与打开/删除。
 *
 * Workspace 文件默认放在扩展 globalStorage 下的 workspaces 目录；
 * 可通过 cursorWorkspace.workspaceStoragePath 覆盖。
 */
export class WorkspaceService {
  private inflightScan: Promise<ProjectListResult> | undefined;
  private memoryCache: ProjectScanCache | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.memoryCache = this.readCacheFile();
  }

  /**
   * 存放候选项目的目录。
   * 优先读本扩展配置；未配置时回退 projectManager.rootFolders，方便与项目管理插件共用。
   */
  getProjectFolders(): string[] {
    const own = this.readPathList(CONFIG_SECTION, "projectFolders");
    if (own.length > 0) {
      return own;
    }
    return this.readPathList("projectManager", "rootFolders");
  }

  /** .code-workspace 文件存放目录 */
  getStorageDir(): string {
    const configured = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>("workspaceStoragePath", "")
      .trim();

    if (configured.length > 0) {
      return this.normalizePath(this.expandHome(configured));
    }

    return this.normalizePath(
      path.join(this.context.globalStorageUri.fsPath, "workspaces")
    );
  }

  ensureStorageDir(): void {
    const dir = this.getStorageDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 当前窗口若打开的是本插件管理的 .code-workspace，返回其路径。
   */
  getCurrentWorkspacePath(): string | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (!workspaceFile || workspaceFile.scheme !== "file") {
      return undefined;
    }
    const filePath = this.normalizePath(workspaceFile.fsPath);
    if (!this.isManagedWorkspaceFile(filePath) || !fs.existsSync(filePath)) {
      return undefined;
    }
    return filePath;
  }

  getCurrentWorkspace(): WorkspaceInfo | undefined {
    const filePath = this.getCurrentWorkspacePath();
    if (!filePath) {
      return undefined;
    }
    return this.readWorkspaceFile(filePath);
  }

  /**
   * 打开系统文件夹选择器，挑选要加入 Workspace 的目录（可多选）。
   */
  async pickProjectFolders(): Promise<ProjectInfo[]> {
    const projectFolders = this.getProjectFolders();
    const defaultUri = projectFolders[0]
      ? vscode.Uri.file(projectFolders[0])
      : undefined;

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: "加入 Workspace",
      title: "选择要加入 Workspace 的文件夹",
      defaultUri,
    });

    if (!uris || uris.length === 0) {
      return [];
    }

    return uris.map((uri) => {
      const folderPath = this.normalizePath(uri.fsPath);
      return {
        path: folderPath,
        name: path.basename(folderPath),
        parentFolder: this.normalizePath(path.dirname(folderPath)),
        manual: true,
      };
    });
  }

  /**
   * 读取仍有效的项目扫描缓存（内存优先，其次本地文件）。
   */
  getCachedProjectList(): ProjectListResult | undefined {
    const projectFolders = this.getProjectFolders();
    const cache = this.memoryCache ?? this.readCacheFile();
    if (!cache || !this.cacheMatches(cache, projectFolders)) {
      return undefined;
    }
    this.memoryCache = cache;
    return {
      projects: cache.projects,
      fromCache: true,
      scannedAt: cache.scannedAt,
    };
  }

  async invalidateProjectCache(): Promise<void> {
    this.memoryCache = undefined;
    this.deleteCacheFile();
    await this.context.globalState.update(PROJECT_CACHE_KEY, undefined);
  }

  /**
   * 获取候选项目列表。默认走缓存；forceRefresh 时重新扫盘并更新缓存。
   */
  async getProjectList(forceRefresh = false): Promise<ProjectListResult> {
    if (!forceRefresh) {
      const cached = this.getCachedProjectList();
      if (cached) {
        return cached;
      }
    }

    if (this.inflightScan) {
      return this.inflightScan;
    }

    this.inflightScan = this.scanAndPersist();
    try {
      return await this.inflightScan;
    } finally {
      this.inflightScan = undefined;
    }
  }

  private cacheMatches(cache: ProjectScanCache, projectFolders: string[]): boolean {
    if (cache.projectFolders.length !== projectFolders.length) {
      return false;
    }
    return cache.projectFolders.every(
      (folder, index) => folder === projectFolders[index]
    );
  }

  private async scanAndPersist(): Promise<ProjectListResult> {
    const projectFolders = this.getProjectFolders();
    const projects = await this.scanProjectsFromDisk(projectFolders);
    const scannedAt = Date.now();
    const cache: ProjectScanCache = {
      projectFolders,
      scannedAt,
      projects: projects.map((project) => ({
        path: project.path,
        name: project.name,
        parentFolder: project.parentFolder,
      })),
    };
    this.memoryCache = cache;
    this.writeCacheFile(cache);
    return {
      projects,
      fromCache: false,
      scannedAt,
    };
  }

  private get cacheFilePath(): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      "project-scan-cache.json"
    );
  }

  private readCacheFile(): ProjectScanCache | undefined {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        return undefined;
      }
      const parsed = JSON.parse(
        fs.readFileSync(this.cacheFilePath, "utf8")
      ) as ProjectScanCache;
      if (!Array.isArray(parsed.projectFolders) || !Array.isArray(parsed.projects)) {
        return undefined;
      }
      return parsed;
    } catch (readCacheErr) {
      console.error("Failed to read project scan cache", readCacheErr);
      return undefined;
    }
  }

  private writeCacheFile(cache: ProjectScanCache): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
      fs.writeFileSync(this.cacheFilePath, `${JSON.stringify(cache)}\n`, "utf8");
    } catch (writeCacheErr) {
      console.error("Failed to write project scan cache", writeCacheErr);
    }
  }

  private deleteCacheFile(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        fs.unlinkSync(this.cacheFilePath);
      }
    } catch (deleteCacheErr) {
      console.error("Failed to delete project scan cache", deleteCacheErr);
    }
  }

  /**
   * 扫描配置的项目目录下的一级文件夹（不递归，忽略隐藏目录）。
   */
  private async scanProjectsFromDisk(
    projectFolders: string[]
  ): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];
    const seen = new Set<string>();

    const folderResults = await Promise.all(
      projectFolders.map((projectFolder) =>
        this.withTimeout(this.scanOneRoot(projectFolder), 2000, [] as ProjectInfo[])
      )
    );

    for (const scanned of folderResults) {
      for (const project of scanned) {
        if (seen.has(project.path)) {
          continue;
        }
        seen.add(project.path);
        projects.push(project);
      }
    }

    return projects.sort((left, right) => {
      const folderCompare = left.parentFolder.localeCompare(
        right.parentFolder,
        ["zh-CN", "en"],
        { numeric: true, sensitivity: "base" }
      );
      if (folderCompare !== 0) {
        return folderCompare;
      }
      return left.name.localeCompare(right.name, ["zh-CN", "en"], {
        numeric: true,
        sensitivity: "base",
      });
    });
  }

  private async scanOneRoot(projectFolder: string): Promise<ProjectInfo[]> {
    try {
      const entries = await fs.promises.readdir(projectFolder, {
        withFileTypes: true,
      });
      const scanned: ProjectInfo[] = [];
      for (const entry of entries) {
        if (!this.isProjectDirectory(entry, projectFolder)) {
          continue;
        }
        scanned.push({
          path: this.normalizePath(path.join(projectFolder, entry.name)),
          name: entry.name,
          parentFolder: this.normalizePath(projectFolder),
        });
      }
      return scanned;
    } catch (readDirErr) {
      console.error(`Failed to read directory: ${projectFolder}`, readDirErr);
      return [];
    }
  }

  /** 不跟随符号链接，避免某个挂载点 stat 卡住整个扫描。 */
  private isProjectDirectory(entry: fs.Dirent, parentFolder: string): boolean {
    if (entry.name.startsWith(".")) {
      return false;
    }
    try {
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (entry.isFile()) {
        return false;
      }
      if (entry.isDirectory()) {
        return true;
      }
      return fs.lstatSync(path.join(parentFolder, entry.name)).isDirectory();
    } catch {
      return false;
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    fallback: T
  ): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        }
      );
    });
  }

  listWorkspaces(): WorkspaceInfo[] {
    this.ensureStorageDir();
    const storageDir = this.getStorageDir();

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(storageDir, { withFileTypes: true });
    } catch (readStorageErr) {
      console.error(`Failed to read workspace storage: ${storageDir}`, readStorageErr);
      return [];
    }

    const workspaces: WorkspaceInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".code-workspace")) {
        continue;
      }

      const filePath = this.normalizePath(path.join(storageDir, entry.name));
      workspaces.push(this.readWorkspaceFile(filePath));
    }

    return workspaces.sort((left, right) =>
      left.name.localeCompare(right.name, ["zh-CN", "en"], {
        numeric: true,
        sensitivity: "base",
      })
    );
  }

  createWorkspace(name: string, projectPaths: string[]): WorkspaceInfo {
    const sanitized = this.sanitizeName(name);
    if (!sanitized) {
      throw new Error("Workspace 名称不能为空");
    }
    if (projectPaths.length === 0) {
      throw new Error("请至少勾选一个项目");
    }

    this.ensureStorageDir();
    const filePath = this.buildFilePath(sanitized);
    if (fs.existsSync(filePath)) {
      throw new Error(`Workspace「${sanitized}」已存在`);
    }

    const folders = this.toFolderEntries(projectPaths);
    this.writeWorkspaceFile(filePath, folders);
    return this.readWorkspaceFile(filePath);
  }

  loadWorkspace(filePath: string): WorkspaceInfo {
    const normalized = this.normalizePath(filePath);
    this.assertManagedFile(normalized);
    if (!fs.existsSync(normalized)) {
      throw new Error("Workspace 文件不存在");
    }
    return this.readWorkspaceFile(normalized);
  }

  updateWorkspace(
    filePath: string,
    name: string,
    projectPaths: string[]
  ): WorkspaceInfo {
    const sanitized = this.sanitizeName(name);
    if (!sanitized) {
      throw new Error("Workspace 名称不能为空");
    }
    if (projectPaths.length === 0) {
      throw new Error("请至少勾选一个项目");
    }

    const currentPath = this.normalizePath(filePath);
    this.assertManagedFile(currentPath);
    if (!fs.existsSync(currentPath)) {
      throw new Error("Workspace 文件不存在");
    }

    const folders = this.toFolderEntries(projectPaths);
    this.writeWorkspaceFile(currentPath, folders);

    const nextPath = this.buildFilePath(sanitized);
    if (nextPath !== currentPath) {
      if (fs.existsSync(nextPath)) {
        throw new Error(`Workspace「${sanitized}」已存在`);
      }
      fs.renameSync(currentPath, nextPath);
      return this.readWorkspaceFile(nextPath);
    }

    return this.readWorkspaceFile(currentPath);
  }

  foldersToProjects(folders: WorkspaceFolderEntry[]): ProjectInfo[] {
    return folders.map((folder) => {
      const folderPath = this.normalizePath(folder.path);
      return {
        path: folderPath,
        name:
          folder.name && folder.name.trim().length > 0
            ? folder.name
            : path.basename(folderPath),
        parentFolder: this.normalizePath(path.dirname(folderPath)),
        manual: true,
      };
    });
  }

  deleteWorkspace(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    this.assertManagedFile(normalized);
    if (!fs.existsSync(normalized)) {
      throw new Error("Workspace 文件不存在");
    }
    fs.unlinkSync(normalized);
  }

  async openWorkspace(filePath: string, newWindow: boolean): Promise<void> {
    const normalized = this.normalizePath(filePath);
    if (!fs.existsSync(normalized)) {
      throw new Error("Workspace 文件不存在");
    }
    const uri = vscode.Uri.file(normalized);
    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: newWindow,
      forceReuseWindow: !newWindow,
    });
  }

  async openStorageFolder(): Promise<void> {
    this.ensureStorageDir();
    await vscode.env.openExternal(vscode.Uri.file(this.getStorageDir()));
  }

  private readWorkspaceFile(filePath: string): WorkspaceInfo {
    const name = path.basename(filePath, ".code-workspace");
    let folders: WorkspaceFolderEntry[] = [];

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as { folders?: WorkspaceFolderEntry[] };
      folders = (parsed.folders ?? []).map((folder) => ({
        path: this.normalizePath(folder.path),
        name: folder.name,
      }));
    } catch (parseWorkspaceErr) {
      console.error(`Failed to parse workspace file: ${filePath}`, parseWorkspaceErr);
    }

    return { name, filePath, folders };
  }

  private writeWorkspaceFile(
    filePath: string,
    folders: WorkspaceFolderEntry[]
  ): void {
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
          string,
          unknown
        >;
        if (parsed && typeof parsed === "object") {
          existing = parsed;
        }
      } catch (readExistingErr) {
        console.error(`Failed to read existing workspace: ${filePath}`, readExistingErr);
      }
    }

    const payload = {
      ...existing,
      folders: folders.map((folder) => {
        const entry: WorkspaceFolderEntry = { path: folder.path };
        if (folder.name) {
          entry.name = folder.name;
        }
        return entry;
      }),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private toFolderEntries(projectPaths: string[]): WorkspaceFolderEntry[] {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const projectPath of projectPaths) {
      const normalized = this.normalizePath(this.expandHome(projectPath.trim()));
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      if (!fs.existsSync(normalized)) {
        throw new Error(`项目路径不存在: ${normalized}`);
      }
      seen.add(normalized);
      unique.push(normalized);
    }

    if (unique.length === 0) {
      throw new Error("请至少勾选一个有效项目");
    }

    return unique.map((projectPath) => ({
      path: projectPath,
      name: path.basename(projectPath),
    }));
  }

  private buildFilePath(name: string): string {
    return this.normalizePath(
      path.join(this.getStorageDir(), `${name}.code-workspace`)
    );
  }

  private isManagedWorkspaceFile(filePath: string): boolean {
    const storageDir = this.getStorageDir();
    const relative = path.relative(storageDir, filePath);
    return (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      filePath.endsWith(".code-workspace")
    );
  }

  private assertManagedFile(filePath: string): void {
    if (!this.isManagedWorkspaceFile(filePath)) {
      throw new Error("只能操作本插件管理的 Workspace 文件");
    }
  }

  sanitizeName(name: string): string {
    return name
      .trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^\.+/, "")
      .slice(0, 100)
      .trim();
  }

  private readPathList(section: string, key: string): string[] {
    const configured = vscode.workspace
      .getConfiguration(section)
      .get<string[]>(key, []);

    return configured
      .map((folder) => this.normalizePath(this.expandHome(folder.trim())))
      .filter((folder) => folder.length > 0);
  }

  private expandHome(input: string): string {
    if (input.startsWith("~/") || input === "~") {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      return path.join(home, input.slice(2));
    }
    return input;
  }

  private normalizePath(input: string): string {
    return path.normalize(input);
  }
}
