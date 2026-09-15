export interface ProjectInfo {
  /** 项目绝对路径 */
  path: string;
  /** 文件夹名 */
  name: string;
  /** 所属的项目目录（配置的扫描路径，或手动选择时的父目录） */
  parentFolder: string;
  /** 是否由路径选择器加入（非扫描列表） */
  manual?: boolean;
}

export interface ProjectScanCache {
  /** 生成缓存时使用的项目目录，用于判断配置是否变化 */
  projectFolders: string[];
  /** 扫描完成时间戳 */
  scannedAt: number;
  projects: Array<Pick<ProjectInfo, "path" | "name" | "parentFolder">>;
}

export interface ProjectListResult {
  projects: ProjectInfo[];
  fromCache: boolean;
  scannedAt: number;
}

export interface WorkspaceFolderEntry {
  path: string;
  name?: string;
}

export interface WorkspaceInfo {
  /** 展示名称（不含扩展名） */
  name: string;
  /** .code-workspace 文件绝对路径 */
  filePath: string;
  /** 工作区包含的文件夹 */
  folders: WorkspaceFolderEntry[];
}
