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
import { TelemetryService } from "./telemetry.js";
import { UpdateService } from "./updater.js";
import type { UpdateStatusInfo } from "@devwit/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let workspace: WorkspaceService | null = null;
let terminal: TerminalService | null = null;
let aiRuntime: AiRuntime | null = null;
let telemetry: TelemetryService | null = null;

function createWindow(): void {
  // E2E 无窗化钩子：DEVWIT_E2E_OFFSCREEN=1 时把窗口移到屏幕外——保持 shown 状态
  // （渲染不节流、CDP 截图证据不受影响），但不弹出遮挡用户其他任务；生产不设置。
  const offscreen = process.env.DEVWIT_E2E_OFFSCREEN === "1";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(offscreen ? { x: -3200, y: -3200, skipTaskbar: true } : {}),
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

  // E2E 钩子（迭代 18 / AC27）：隔离 userData 环境默认抑制首跑向导——否则向导遮罩
  // 会挡住既有自动化套件的首击目标；向导自身的 e2e 以 DEVWIT_E2E_WIZARD=1 显式开启。
  // 生产启动两个变量都不设置，向导按 onboarding.state 正常判定。
  if (e2eUserData !== undefined && e2eUserData !== "" && process.env.DEVWIT_E2E_WIZARD !== "1") {
    if (settings.get("onboarding.state") === undefined) {
      settings.set("onboarding.state", { completed: true });
    }
  }

  workspace = new WorkspaceService();
  terminal = new TerminalService();

  const send = (channel: string, ...args: unknown[]): void => {
    mainWindow?.webContents.send(channel, ...args);
  };

  // 匿名遥测（AC39）：opt-in 默认关闭，零内容收集，端点可配置。
  // 配置修改热生效——settings.onChanged("telemetry") 即时重配置，无需重启。
  // E2E 钩子 DEVWIT_TELEMETRY_FLUSH_MS 缩短周期 flush 间隔（确定性断言）。
  const telemetryFlushMs = Number(process.env.DEVWIT_TELEMETRY_FLUSH_MS);
  telemetry = new TelemetryService({
    settings,
    version: app.getVersion(),
    os: process.platform,
    ...(Number.isFinite(telemetryFlushMs) && telemetryFlushMs > 0 ? { flushMs: telemetryFlushMs } : {}),
  });
  settings.onChanged((key) => {
    if (key === "telemetry") telemetry?.configure();
  });
  telemetry.start();

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
      // 迭代 14 / AC23 模式导出/导入对话框；E2E 钩子跳过原生框（同 DEVWIT_E2E_OPEN_DIR 口径）
      saveJsonFile: async (defaultName) => {
        const e2ePath = process.env.DEVWIT_E2E_EXPORT_PATH;
        if (e2ePath !== undefined && e2ePath !== "") {
          return e2ePath;
        }
        if (!mainWindow) {
          return null;
        }
        const result = await dialog.showSaveDialog(mainWindow, {
          defaultPath: defaultName,
          filters: [{ name: "DevWit Mode", extensions: ["json"] }]
        });
        return result.canceled || result.filePath === undefined || result.filePath === "" ? null : result.filePath;
      },
      openJsonFile: async () => {
        const e2ePath = process.env.DEVWIT_E2E_IMPORT_PATH;
        if (e2ePath !== undefined && e2ePath !== "") {
          return e2ePath;
        }
        if (!mainWindow) {
          return null;
        }
        const result = await dialog.showOpenDialog(mainWindow, {
          properties: ["openFile"],
          filters: [{ name: "DevWit Mode", extensions: ["json"] }]
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
  // AC39：退出前尽力 flush 残余遥测缓冲（不阻塞退出）
  telemetry?.stop();
});
