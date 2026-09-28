import * as vscode from "vscode";
import { CreateWorkspacePanel } from "./createWorkspacePanel";
import { WorkspaceInfo } from "./types";
import {
  WorkspaceItem,
  WorkspaceTreeNode,
  WorkspaceTreeProvider,
} from "./workspaceTreeProvider";
import { WorkspaceService } from "./workspaceService";

/**
 * 扩展激活入口。
 *
 * 负责：
 * 1. 初始化 Workspace 存储目录与侧栏树
 * 2. 注册打开 / 新建 / 删除等命令
 * 3. 未配置项目根路径时给出引导
 */
export function activate(context: vscode.ExtensionContext): void {
  const workspaceService = new WorkspaceService(context);

  workspaceService.migrateStoragePathSetting();
  void workspaceService.clearObsoleteDefaultPathSetting();
  void workspaceService.migrateProjectFoldersSetting();
  void workspaceService.ensureDefaultStoragePathFilled();
  void workspaceService.getProjectList(false);

  const treeProvider = new WorkspaceTreeProvider(workspaceService);
  const updateHasCurrent = () => {
    void vscode.commands.executeCommand(
      "setContext",
      "cursorWorkspace.hasCurrent",
      Boolean(workspaceService.getCurrentWorkspacePath())
    );
  };

  const refresh = () => {
    treeProvider.refresh();
    updateHasCurrent();
  };

  updateHasCurrent();

  const onSaved = async (filePath: string, openAfter: boolean) => {
    refresh();
    if (openAfter) {
      await workspaceService.openWorkspace(filePath, true);
    }
  };

  const openEditor = (editing?: WorkspaceInfo) => {
    CreateWorkspacePanel.show(
      context.extensionUri,
      workspaceService,
      onSaved,
      editing
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorWorkspace.create", () => {
      openEditor();
    }),
    vscode.commands.registerCommand("cursorWorkspace.refresh", () => {
      refresh();
      vscode.window.setStatusBarMessage("Workspace 列表已刷新", 2000);
    })
  );

  let treeView: vscode.TreeView<WorkspaceTreeNode> | undefined;
  try {
    treeView = vscode.window.createTreeView("cursorWorkspace.workspaces", {
      treeDataProvider: treeProvider,
    });
  } catch (createTreeViewErr) {
    console.error("Failed to create tree view, falling back", createTreeViewErr);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(
        "cursorWorkspace.workspaces",
        treeProvider
      )
    );
  }

  try {
    workspaceService.ensureStorageDir();
  } catch (ensureStorageDirErr) {
    console.error("Failed to ensure storage dir", ensureStorageDirErr);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(CreateWorkspacePanel.viewType, {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        CreateWorkspacePanel.revive(
          webviewPanel,
          context.extensionUri,
          workspaceService,
          onSaved
        );
      },
    })
  );

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, 200);
  };

  context.subscriptions.push(
    ...(treeView ? [treeView] : []),
    {
      dispose: () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
      },
    },

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scheduleRefresh();
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cursorWorkspace.projectFolders")) {
        void workspaceService.invalidateProjectCache();
      }
      if (event.affectsConfiguration("cursorWorkspace")) {
        scheduleRefresh();
      }
      if (event.affectsConfiguration("cursorWorkspace.workspaceStoragePath")) {
        try {
          workspaceService.ensureStorageDir();
        } catch (ensureStorageDirErr) {
          console.error("Failed to ensure storage dir", ensureStorageDirErr);
        }
      }
    }),

    vscode.commands.registerCommand("cursorWorkspace.openSettings", async () => {
      await workspaceService.ensureDefaultStoragePathFilled();
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:local.cursor-workspace"
      );
    }),

    vscode.commands.registerCommand(
      "cursorWorkspace.open",
      async (item?: WorkspaceItem | string) => {
        await openWorkspace(workspaceService, item, true);
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.openInNewWindow",
      async (item?: WorkspaceItem | string) => {
        await openWorkspace(workspaceService, item, true);
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.edit",
      async (item?: WorkspaceItem) => {
        const filePath = resolveWorkspacePath(item);
        if (!filePath) {
          return;
        }
        try {
          const workspace = workspaceService.loadWorkspace(filePath);
          openEditor(workspace);
        } catch (editWorkspaceErr) {
          const message =
            editWorkspaceErr instanceof Error
              ? editWorkspaceErr.message
              : String(editWorkspaceErr);
          vscode.window.showErrorMessage(`打开编辑失败: ${message}`);
        }
      }
    ),

    vscode.commands.registerCommand("cursorWorkspace.editCurrent", () => {
      const current = workspaceService.getCurrentWorkspace();
      if (!current) {
        vscode.window.showInformationMessage(
          "当前窗口不是本插件管理的 Workspace。"
        );
        return;
      }
      openEditor(current);
    }),

    vscode.commands.registerCommand(
      "cursorWorkspace.delete",
      async (item?: WorkspaceItem) => {
        const filePath = resolveWorkspacePath(item);
        if (!filePath) {
          return;
        }

        const name =
          item instanceof WorkspaceItem
            ? item.workspace.name
            : filePath;
        const confirmed = await vscode.window.showWarningMessage(
          `确认删除 Workspace「${name}」？仅删除 workspace 文件，不会删除项目目录。`,
          { modal: true },
          "删除"
        );
        if (confirmed !== "删除") {
          return;
        }

        try {
          workspaceService.deleteWorkspace(filePath);
          refresh();
          vscode.window.setStatusBarMessage(`已删除 Workspace「${name}」`, 2000);
        } catch (deleteWorkspaceErr) {
          const message =
            deleteWorkspaceErr instanceof Error
              ? deleteWorkspaceErr.message
              : String(deleteWorkspaceErr);
          vscode.window.showErrorMessage(`删除失败: ${message}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.openStorageFolder",
      async () => {
        try {
          await workspaceService.openStorageFolder();
        } catch (openStorageErr) {
          const message =
            openStorageErr instanceof Error
              ? openStorageErr.message
              : String(openStorageErr);
          vscode.window.showErrorMessage(`打开存放目录失败: ${message}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.pickStoragePath",
      async () => {
        try {
          const picked = await workspaceService.pickStorageDir();
          if (!picked) {
            return;
          }
          await workspaceService.setStoragePath(picked);
          vscode.window.setStatusBarMessage(
            `工作区目录已设为 ${picked}`,
            3000
          );
        } catch (pickStoragePathErr) {
          const message =
            pickStoragePathErr instanceof Error
              ? pickStoragePathErr.message
              : String(pickStoragePathErr);
          vscode.window.showErrorMessage(`选择工作区目录失败: ${message}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.useDefaultStoragePath",
      async () => {
        try {
          const defaultDir = workspaceService.getDefaultStorageDir();
          await workspaceService.setStoragePath(defaultDir);
          vscode.window.setStatusBarMessage(
            `工作区目录已设为默认路径 ${defaultDir}`,
            3000
          );
        } catch (useDefaultPathErr) {
          const message =
            useDefaultPathErr instanceof Error
              ? useDefaultPathErr.message
              : String(useDefaultPathErr);
          vscode.window.showErrorMessage(`设置默认工作区目录失败: ${message}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "cursorWorkspace.pickProjectFolder",
      async () => {
        try {
          const picked = await workspaceService.pickProjectRootDir();
          if (!picked) {
            return;
          }
          const added = await workspaceService.addProjectFolders([picked]);
          if (added.length === 0) {
            vscode.window.setStatusBarMessage(`路径已在列表中: ${picked}`, 2000);
            return;
          }
          vscode.window.setStatusBarMessage(`已添加 ${added[0]}`, 2000);
        } catch (pickProjectFolderErr) {
          const message =
            pickProjectFolderErr instanceof Error
              ? pickProjectFolderErr.message
              : String(pickProjectFolderErr);
          vscode.window.showErrorMessage(message);
        }
      }
    )
  );
}

async function openWorkspace(
  workspaceService: WorkspaceService,
  item: WorkspaceItem | string | undefined,
  newWindow: boolean
): Promise<void> {
  const filePath = resolveWorkspacePath(item);
  if (!filePath) {
    return;
  }

  try {
    await workspaceService.openWorkspace(filePath, newWindow);
  } catch (openWorkspaceErr) {
    const message =
      openWorkspaceErr instanceof Error
        ? openWorkspaceErr.message
        : String(openWorkspaceErr);
    vscode.window.showErrorMessage(`打开 Workspace 失败: ${message}`);
  }
}

function resolveWorkspacePath(
  item?: WorkspaceItem | string
): string | undefined {
  if (!item) {
    return undefined;
  }
  if (typeof item === "string") {
    return item;
  }
  return item.workspace.filePath;
}

export function deactivate(): void {}
