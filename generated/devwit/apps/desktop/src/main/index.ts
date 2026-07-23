/**
 * DevWit Electron 主进程入口（WU005）。
 * ESM 主进程（electron 37+）。窗口 webPreferences 锁定：
 * contextIsolation=true / sandbox=true / nodeIntegration=false（AR001），
 * 渲染进程能力仅经 preload 白名单 IPC（apps/desktop/src/main/preload.ts）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { SettingsStore } from "@devwit/settings";
import { TerminalService } from "@devwit/terminal";
import { buildFileTree, WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "./ai-runtime.js";
import { registerIpcHandlers } from "./ipc.js";
import { SafeStorageBackend } from "./safe-storage-backend.js";
import { UpdateService } from "./updater.js";
import type { UpdateStatusInfo } from "@devwit/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let workspace: WorkspaceService | null = null;
let terminal: TerminalService | null = null;
let aiRuntime: AiRuntime | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(here, "preload.cjs")
    }
  });
  void mainWindow.loadFile(path.join(here, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // AR005：safeStorage 不可用时拒绝启动，绝不降级为明文存储
  if (!safeStorage.isEncryptionAvailable()) {
    dialog.showErrorBox(
      "DevWit 无法启动",
      "当前系统不支持安全加密存储（safeStorage unavailable），为保护 API 凭证，应用拒绝以明文降级运行。"
    );
    app.exit(1);
    return;
  }

  // E2E 隔离钩子：DEVWIT_USER_DATA_DIR 指定独立 userData（与 DEVWIT_E2E_OPEN_DIR 同类，
  // 避免测试与用户真实配置互相污染；生产启动不设置即走默认路径）。
  const e2eUserData = process.env.DEVWIT_USER_DATA_DIR;
  if (e2eUserData !== undefined && e2eUserData !== "") {
    app.setPath("userData", e2eUserData);
  }

  const settings = new SettingsStore(new SafeStorageBackend(), app.getPath("userData"));
  workspace = new WorkspaceService();
  terminal = new TerminalService();

  const send = (channel: string, ...args: unknown[]): void => {
    mainWindow?.webContents.send(channel, ...args);
  };

  // 自动更新（AC16）：E2E 钩子 DEVWIT_E2E_FAKE_UPDATE 注入合成状态序列
  // （真实加载 electron-updater 验证 bundle 完整性，但不联网检查、不下载）。
  const fakeUpdate: UpdateStatusInfo[] | undefined =
    process.env.DEVWIT_E2E_FAKE_UPDATE !== undefined && process.env.DEVWIT_E2E_FAKE_UPDATE !== ""
      ? [
          { state: "checking" },
          { state: "available", version: "9.9.9" },
          { state: "downloading", percent: 42 },
          { state: "ready", version: "9.9.9" },
        ]
      : undefined;
  const updater = new UpdateService({ send, isPackaged: app.isPackaged, ...(fakeUpdate !== undefined ? { fakeSequence: fakeUpdate } : {}) });

  // AI 子系统（WU008-WU012 接线）：manifest 落盘 userData/manifests（AC2 审计产物）
  const ai = new AiRuntime({
    settings,
    workspace,
    send,
    manifestsDir: path.join(app.getPath("userData"), "manifests"),
  });
  aiRuntime = ai;

  registerIpcHandlers({
    ipcMain,
    services: { workspace, terminal, settings },
    hooks: {
      openDirectoryDialog: async () => {
        // E2E 冒烟钩子：设置 DEVWIT_E2E_OPEN_DIR 时跳过系统原生目录选择框
        // （原生对话框无法被自动化驱动；对话框之后的 IPC/渲染链路保持全真实）。
        const e2eDir = process.env.DEVWIT_E2E_OPEN_DIR;
        if (e2eDir !== undefined && e2eDir !== "") {
          return e2eDir;
        }
        if (!mainWindow) {
          return null;
        }
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ["openDirectory"]
        });
        return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
      },
      buildTree: (root) => buildFileTree(root),
      send,
    },
    ai,
    update: { service: updater, version: app.getVersion() },
  });

  createWindow();

  // 启动静默检查（AC16）：渲染进程脚本加载完毕（onStatus 订阅就位）后再发起，
  // 避免早期状态事件丢失；失败/无更新均不打扰用户（仅状态条瞬态提示）。
  mainWindow?.webContents.on("did-finish-load", () => {
    void updater.start();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  terminal?.disposeAll();
  workspace?.close();
  // AC17：退出前停止全部 MCP 子进程，避免孤儿进程驻留
  if (aiRuntime !== null) void aiRuntime.dispose();
});
