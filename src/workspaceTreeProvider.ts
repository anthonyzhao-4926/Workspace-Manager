import * as path from "path";
import * as vscode from "vscode";
import { WorkspaceFolderEntry, WorkspaceInfo } from "./types";
import { WorkspaceService } from "./workspaceService";

export type WorkspaceTreeNode = WorkspaceGroupItem | WorkspaceItem;

export class WorkspaceGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly groupId: "current" | "all"
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `cursor-workspace-group-${groupId}`;
    this.contextValue = "workspaceGroup";
    this.iconPath =
      groupId === "current"
        ? new vscode.ThemeIcon(
            "star-full",
            new vscode.ThemeColor("charts.yellow")
          )
        : new vscode.ThemeIcon("folder-library");
  }
}

export class WorkspaceItem extends vscode.TreeItem {
  constructor(
    public readonly workspace: WorkspaceInfo,
    public readonly isCurrent = false
  ) {
    super(workspace.name, vscode.TreeItemCollapsibleState.None);

    const folderCount = workspace.folders.length;
    this.id = `cursor-workspace-${workspace.filePath}`;
    this.description = isCurrent
      ? `当前 · ${folderCount} 个项目`
      : `${folderCount} 个项目`;
    this.contextValue = isCurrent ? "workspaceCurrent" : "workspace";
    this.iconPath = isCurrent
      ? new vscode.ThemeIcon(
          "star-full",
          new vscode.ThemeColor("charts.yellow")
        )
      : new vscode.ThemeIcon("folder-library");

    if (isCurrent) {
      this.label = {
        label: workspace.name,
        highlights: [[0, workspace.name.length]],
      };
    }

    const folderLines =
      folderCount === 0
        ? "未包含任何项目"
        : workspace.folders.map((folder) => folderDisplayName(folder)).join("\n");
    this.tooltip = isCurrent
      ? `当前打开\n${folderLines}\n\n点击可向此 Workspace 添加项目`
      : folderLines;

    this.command = isCurrent
      ? {
          command: "cursorWorkspace.edit",
          title: "向当前 Workspace 添加项目",
          arguments: [this],
        }
      : {
          command: "cursorWorkspace.open",
          title: "打开 Workspace",
          arguments: [this],
        };
  }
}

function folderDisplayName(folder: WorkspaceFolderEntry): string {
  if (folder.name && folder.name.trim().length > 0) {
    return folder.name;
  }
  return path.basename(folder.path);
}

export class WorkspaceTreeProvider
  implements vscode.TreeDataProvider<WorkspaceTreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    WorkspaceTreeNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly workspaceService: WorkspaceService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorkspaceTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkspaceTreeNode): Thenable<WorkspaceTreeNode[]> {
    if (element instanceof WorkspaceGroupItem) {
      return Promise.resolve(this.groupChildren(element.groupId));
    }

    const workspaces = this.workspaceService.listWorkspaces();
    const currentPath = this.workspaceService.getCurrentWorkspacePath();
    const hasCurrent = Boolean(
      currentPath && workspaces.some((workspace) => workspace.filePath === currentPath)
    );

    if (!hasCurrent) {
      return Promise.resolve(
        workspaces.map((workspace) => new WorkspaceItem(workspace, false))
      );
    }

    const others = workspaces.filter(
      (workspace) => workspace.filePath !== currentPath
    );
    const nodes: WorkspaceTreeNode[] = [
      new WorkspaceGroupItem("当前打开", "current"),
    ];
    if (others.length > 0) {
      nodes.push(new WorkspaceGroupItem("全部 Workspace", "all"));
    }
    return Promise.resolve(nodes);
  }

  private groupChildren(groupId: "current" | "all"): WorkspaceItem[] {
    const workspaces = this.workspaceService.listWorkspaces();
    const currentPath = this.workspaceService.getCurrentWorkspacePath();
    if (groupId === "current") {
      const current = workspaces.find(
        (workspace) => workspace.filePath === currentPath
      );
      return current ? [new WorkspaceItem(current, true)] : [];
    }
    return workspaces
      .filter((workspace) => workspace.filePath !== currentPath)
      .map((workspace) => new WorkspaceItem(workspace, false));
  }
}
