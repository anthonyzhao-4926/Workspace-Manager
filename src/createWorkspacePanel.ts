import * as vscode from "vscode";
import { ProjectInfo, WorkspaceInfo } from "./types";
import { WorkspaceService } from "./workspaceService";

interface EditorPayload {
  storageDir: string;
  projects: Array<Pick<ProjectInfo, "path" | "name" | "parentFolder" | "manual">>;
  fromCache: boolean;
  scannedAt: number;
  scanning: boolean;
  mode: "create" | "edit";
  workspaceName: string;
  selectedPaths: string[];
  initForm: boolean;
  hasCurrentWorkspace: boolean;
  currentWorkspaceName: string;
  editingCurrent: boolean;
}

type IncomingMessage =
  | { type: "shellPainted" }
  | { type: "visiblePainted" }
  | { type: "pickFolders" }
  | { type: "refreshProjects" }
  | { type: "editCurrent" }
  | { type: "save"; name: string; projectPaths: string[]; openAfter: boolean };

/**
 * 新建 / 编辑 Workspace 面板：在编辑器区域打开独立页，勾选扫描到的项目。
 * 同一窗口内复用同一个 Webview，保存后不销毁。
 * 点新建立刻 reveal 已预热的骨架页；列表脚本 defer，不挡首屏。
 */
export class CreateWorkspacePanel {
  public static readonly viewType = "cursorWorkspace.create";

  private static currentPanel: CreateWorkspacePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private editing: WorkspaceInfo | undefined;
  private pendingInit = true;
  private wantProjects = false;
  private shellPainted = false;
  private visiblePaintRequested = false;
  private projectsPosted = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceService: WorkspaceService,
    private readonly onSaved: (filePath: string, openAfter: boolean) => Promise<void>,
    editing?: WorkspaceInfo,
    wantProjects = false
  ) {
    this.panel = panel;
    this.editing = editing;
    this.wantProjects = wantProjects;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => this.onViewStateChanged(),
      null,
      this.disposables
    );

    this.panel.webview.onDidReceiveMessage(
      async (message: IncomingMessage) => {
        try {
          switch (message.type) {
            case "shellPainted":
              this.shellPainted = true;
              this.requestVisiblePaint();
              break;
            case "visiblePainted":
              this.fillProjectsIfReady();
              break;
            case "pickFolders":
              await this.handlePickFolders();
              break;
            case "refreshProjects":
              await this.postState(true);
              break;
            case "editCurrent":
              this.handleEditCurrent();
              break;
            case "save":
              await this.handleSave(
                message.name,
                message.projectPaths,
                message.openAfter
              );
              break;
          }
        } catch (createPanelErr) {
          const text =
            createPanelErr instanceof Error
              ? createPanelErr.message
              : String(createPanelErr);
          vscode.window.showErrorMessage(text);
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  static prewarm(
    extensionUri: vscode.Uri,
    workspaceService: WorkspaceService,
    onSaved: (filePath: string, openAfter: boolean) => Promise<void>
  ): void {
    if (CreateWorkspacePanel.currentPanel) {
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CreateWorkspacePanel.viewType,
      "新建 Workspace",
      {
        viewColumn: vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        preserveFocus: true,
      },
      CreateWorkspacePanel.panelOptions(extensionUri)
    );
    CreateWorkspacePanel.currentPanel = new CreateWorkspacePanel(
      panel,
      extensionUri,
      workspaceService,
      onSaved
    );
  }

  static show(
    extensionUri: vscode.Uri,
    workspaceService: WorkspaceService,
    onSaved: (filePath: string, openAfter: boolean) => Promise<void>,
    editing?: WorkspaceInfo
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn;
    const title = editing ? "编辑 Workspace" : "新建 Workspace";

    if (CreateWorkspacePanel.currentPanel) {
      const current = CreateWorkspacePanel.currentPanel;
      current.editing = editing;
      current.pendingInit = true;
      current.panel.title = title;
      current.beginShow(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateWorkspacePanel.viewType,
      title,
      { viewColumn: column ?? vscode.ViewColumn.One, preserveFocus: false },
      CreateWorkspacePanel.panelOptions(extensionUri)
    );

    CreateWorkspacePanel.currentPanel = new CreateWorkspacePanel(
      panel,
      extensionUri,
      workspaceService,
      onSaved,
      editing,
      true
    );
  }

  private static panelOptions(
    extensionUri: vscode.Uri
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    };
  }

  private beginShow(column?: vscode.ViewColumn): void {
    this.wantProjects = true;
    this.projectsPosted = false;
    this.shellPainted = false;
    this.visiblePaintRequested = false;
    this.panel.reveal(column);
    void this.resetToShell();
  }

  private resetToShell(): Thenable<boolean> {
    return this.panel.webview.postMessage({
      type: "showShell",
      ...this.shellPayload(),
    });
  }

  private shellPayload(): Omit<EditorPayload, "projects" | "fromCache" | "scannedAt" | "scanning"> {
    return {
      storageDir: this.workspaceService.getStorageDir(),
      mode: this.editing ? "edit" : "create",
      workspaceName: this.editing?.name ?? "",
      selectedPaths: this.editing
        ? this.workspaceService
            .foldersToProjects(this.editing.folders)
            .map((project) => project.path)
        : [],
      initForm: true,
      ...this.currentEditorMeta(),
    };
  }

  private onViewStateChanged(): void {
    if (!this.panel.visible) {
      this.visiblePaintRequested = false;
      return;
    }
    this.requestVisiblePaint();
  }

  private requestVisiblePaint(): void {
    if (
      !this.wantProjects ||
      !this.shellPainted ||
      this.projectsPosted ||
      !this.panel.visible ||
      this.visiblePaintRequested
    ) {
      return;
    }
    this.visiblePaintRequested = true;
    void this.panel.webview.postMessage({ type: "confirmVisiblePaint" });
  }

  private fillProjectsIfReady(): void {
    if (
      !this.wantProjects ||
      !this.shellPainted ||
      !this.panel.visible ||
      this.projectsPosted
    ) {
      return;
    }
    this.projectsPosted = true;
    void this.postState();
  }

  private handleEditCurrent(): void {
    const current = this.workspaceService.getCurrentWorkspace();
    if (!current) {
      vscode.window.showInformationMessage(
        "当前窗口不是本插件管理的 Workspace。"
      );
      return;
    }
    this.editing = current;
    this.pendingInit = true;
    this.panel.title = "编辑 Workspace";
    void this.postState();
  }

  private currentEditorMeta(): Pick<
    EditorPayload,
    "hasCurrentWorkspace" | "currentWorkspaceName" | "editingCurrent"
  > {
    const currentWorkspace = this.workspaceService.getCurrentWorkspace();
    return {
      hasCurrentWorkspace: Boolean(currentWorkspace),
      currentWorkspaceName: currentWorkspace?.name ?? "",
      editingCurrent: Boolean(
        this.editing &&
          currentWorkspace &&
          this.editing.filePath === currentWorkspace.filePath
      ),
    };
  }

  private async handlePickFolders(): Promise<void> {
    const picked = await this.workspaceService.pickProjectFolders();
    if (picked.length === 0) {
      return;
    }
    this.panel.reveal();
    await this.panel.webview.postMessage({
      type: "addProjects",
      projects: picked,
    });
  }

  private async handleSave(
    name: string,
    projectPaths: string[],
    openAfter: boolean
  ): Promise<void> {
    const saved = this.editing
      ? this.workspaceService.updateWorkspace(
          this.editing.filePath,
          name,
          projectPaths
        )
      : this.workspaceService.createWorkspace(name, projectPaths);
    const action = this.editing ? "已更新" : "已创建";
    vscode.window.setStatusBarMessage(`${action} Workspace「${saved.name}」`, 3000);
    this.editing = undefined;
    this.pendingInit = true;
    this.panel.title = "新建 Workspace";
    await this.postState();
    await this.onSaved(saved.filePath, openAfter);
    await vscode.commands.executeCommand("workbench.action.previousEditor");
  }

  private mergeProjects(scanned: ProjectInfo[]): ProjectInfo[] {
    if (!this.editing) {
      return scanned;
    }
    const extras = this.workspaceService.foldersToProjects(this.editing.folders);
    const seen = new Set(scanned.map((project) => project.path));
    const merged = [...scanned];
    for (const extra of extras) {
      if (seen.has(extra.path)) {
        continue;
      }
      seen.add(extra.path);
      merged.push(extra);
    }
    return merged;
  }

  private async postState(forceRefresh = false): Promise<void> {
    const storageDir = this.workspaceService.getStorageDir();
    const initForm = this.pendingInit;
    const mode: "create" | "edit" = this.editing ? "edit" : "create";
    const workspaceName = this.editing?.name ?? "";
    const selectedPaths = this.editing
      ? this.workspaceService
          .foldersToProjects(this.editing.folders)
          .map((project) => project.path)
      : [];

    this.panel.title = mode === "edit" ? "编辑 Workspace" : "新建 Workspace";
    const currentMeta = this.currentEditorMeta();

    const postFullState = async (
      projects: ProjectInfo[],
      fromCache: boolean,
      scannedAt: number,
      scanning: boolean
    ) => {
      await this.panel.webview.postMessage({
        type: "state",
        storageDir,
        projects: this.mergeProjects(projects),
        fromCache,
        scannedAt,
        scanning,
        mode,
        workspaceName,
        selectedPaths,
        initForm,
        ...currentMeta,
      } satisfies EditorPayload & { type: "state" });
      if (!scanning) {
        this.pendingInit = false;
      }
    };

    if (!forceRefresh) {
      const cached = this.workspaceService.getCachedProjectList();
      if (cached) {
        await postFullState(cached.projects, true, cached.scannedAt, false);
        return;
      }

      await postFullState([], false, 0, true);
      void this.workspaceService.getProjectList(false).then((result) => {
        if (CreateWorkspacePanel.currentPanel !== this) {
          return;
        }
        void postFullState(
          result.projects,
          result.fromCache,
          result.scannedAt,
          false
        );
      });
      return;
    }

    await this.panel.webview.postMessage({
      type: "scanning",
      scanning: true,
    });
    const result = await this.workspaceService.getProjectList(true);
    await postFullState(result.projects, result.fromCache, result.scannedAt, false);
  }

  private dispose(): void {
    CreateWorkspacePanel.currentPanel = undefined;
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "createWorkspace.js")
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Workspace 编辑</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #pageContent {
      padding: 16px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 20px;
      font-weight: 600;
    }
    .subtitle {
      margin: 0 0 16px;
      opacity: 0.75;
      font-size: 12px;
    }
    .section { margin-bottom: 12px; }
    label.field {
      display: block;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 5px 8px;
      border-radius: 4px;
      outline: none;
    }
    input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    .toolbar {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar input { flex: 1; min-width: 0; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 5px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:disabled { opacity: 0.6; cursor: default; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .group { margin-bottom: 10px; }
    .group-title {
      font-size: 11px;
      font-weight: 600;
      opacity: 0.8;
      margin: 0 0 4px;
      word-break: break-all;
    }
    .project-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 6px;
      border-radius: 4px;
    }
    .project-item:hover { background: var(--vscode-list-hoverBackground); }
    .project-item label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      cursor: pointer;
      flex: 1;
      min-width: 0;
    }
    .project-name { font-weight: 500; }
    .project-path {
      font-size: 11px;
      opacity: 0.7;
      word-break: break-all;
    }
    .empty {
      opacity: 0.7;
      font-size: 12px;
      padding: 16px 8px;
      text-align: center;
    }
    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 160px;
      padding: 28px 12px;
    }
    .loading-spinner {
      width: 22px;
      height: 22px;
      border: 2px solid var(--vscode-widget-border, rgba(128,128,128,.35));
      border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    .loading-text {
      font-size: 12px;
      opacity: 0.8;
    }
    .loading-text::after {
      display: inline-block;
      width: 1.25em;
      text-align: left;
      content: '';
      animation: loading-dots 1.2s steps(4, end) infinite;
    }
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-editor-background);
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes loading-dots {
      0% { content: ''; }
      25% { content: '.'; }
      50% { content: '..'; }
      75% { content: '...'; }
    }
    .count { font-size: 11px; opacity: 0.75; margin-left: auto; }
    .project-list {
      position: relative;
      max-height: calc(100vh - 280px);
      overflow: auto;
    }
    .current-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .current-banner[hidden] { display: none; }
    .current-banner-label {
      font-size: 10px;
      opacity: 0.75;
    }
    .current-banner-name {
      font-weight: 600;
      font-size: 12px;
      word-break: break-all;
    }
    .current-tag {
      display: inline-block;
      margin-left: 6px;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 999px;
      vertical-align: middle;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
    }
    .current-tag[hidden] { display: none; }
    .picker {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 8px;
      align-items: stretch;
    }
    .picker-col {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .picker-col-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    }
    .picker-col-selected .picker-col-title {
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .project-item.is-checked {
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .project-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remove-btn {
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.75;
      padding: 2px 6px;
      flex-shrink: 0;
    }
    .remove-btn:hover { opacity: 1; }
  </style>
</head>
<body>
  <div id="pageContent">
  <div id="currentBanner" class="current-banner" hidden>
    <div>
      <div class="current-banner-label">当前打开</div>
      <div class="current-banner-name" id="currentBannerName"></div>
    </div>
    <button id="editCurrentBtn" type="button">向当前添加项目</button>
  </div>
  <h1>
    <span id="pageTitle">新建 Workspace</span>
    <span id="currentTag" class="current-tag" hidden>当前打开</span>
  </h1>
  <p class="subtitle" id="subtitle">勾选项目，或用路径选择器加入文件夹。</p>
  <div class="section">
    <label class="field" for="nameInput">Workspace 名称</label>
    <input id="nameInput" type="text" placeholder="建议与分支名称保持一致" />
  </div>
  <div class="section">
    <div class="toolbar">
      <input id="filterInput" type="text" placeholder="筛选项目名称" />
      <button id="pickFoldersBtn">选择文件夹</button>
      <button id="refreshProjectsBtn" class="secondary">刷新</button>
    </div>
    <div class="picker">
      <div class="picker-col">
        <div class="picker-col-title">可选项目</div>
        <div id="projectList" class="project-list">
          <div class="loading">
            <div class="loading-spinner" aria-hidden="true"></div>
            <div class="loading-text">正在加载项目列表</div>
          </div>
        </div>
      </div>
      <div class="picker-col picker-col-selected">
        <div class="picker-col-title">已选择 <span class="count" id="countLabel">0</span></div>
        <div id="selectedList" class="project-list">
          <div class="empty">尚未选择项目</div>
        </div>
      </div>
    </div>
  </div>
  <div class="section actions">
    <button id="saveBtn" class="secondary">仅创建</button>
    <button id="saveOpenBtn">创建并打开</button>
  </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}" defer></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let index = 0; index < 32; index += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
