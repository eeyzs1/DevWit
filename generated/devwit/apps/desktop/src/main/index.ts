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
import { createNodeEnvironment } from "@devwit/agent-runtime";
import { TerminalService } from "@devwit/terminal";
import { buildFileTree, WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "./ai-runtime.js";
import { DebugMainService } from "./debug-service.js";
import { registerIpcHandlers } from "./ipc.js";
import { GitMainService } from "./git-service.js";
import { LspService } from "./lsp-service.js";
import { RegexMatchService } from "./regex-matcher.js";
import { SafeStorageBackend } from "./safe-storage-backend.js";
import { TelemetryService } from "./telemetry.js";
import { UpdateService } from "./updater.js";
import type { UpdateStatusInfo } from "@devwit/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let workspace: WorkspaceService | null = null;
let terminal: TerminalService | null = null;
/** 更新服务（v0.7.26 / R7-8：createWindow 内 did-finish-load 钩子引用）。 */
let updater: UpdateService | null = null;
let aiRuntime: AiRuntime | null = null;
let telemetry: TelemetryService | null = null;
let lspService: LspService | null = null;
let debugService: DebugMainService | null = null;
/** v0.7.5：grep 正则匹配 worker 服务（whenReady 内创建，will-quit 回收）。 */
let regexMatcher: RegexMatchService | null = null;

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
  // 导航防护（Electron 安全清单）：渲染层一旦被攻破（如模型输出注入），不得借
  // window.location / window.open 跳转远程页面——preload 桥会随导航挂到远程文档上。
  // loadFile 等程序化导航不触发 will-navigate，不影响正常启动与 E2E。
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // v0.7.26（审查 R7-8）：静默更新检查挂到 createWindow 内（每个新窗口的
  // webContents 都获得一次机会——macOS 关窗重建后不再漏检），且只对首个
  // 完成加载真正发起（updaterStarted 单次标记防 reload 重复网络检查）。
  mainWindow.webContents.on("did-finish-load", () => {
    if (updaterStarted) return;
    updaterStarted = true;
    void updater?.start();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // v0.7.25（审查 R7-7a）：渲染层重载/崩溃时回收全部终端会话——reload
  //（默认菜单 Ctrl+R 可触发）后渲染端丢失会话 id，pty 与输出订阅全部滞留
  //（shell 进程持续运行直到退出应用）。首次 loadFile 同样触发，但彼时会话
  // 表为空，no-op。
  mainWindow.webContents.on("did-start-navigation", () => {
    terminal?.disposeAll();
  });
  mainWindow.webContents.on("render-process-gone", () => {
    terminal?.disposeAll();
  });
}

// v0.7.23 修复（审查 R7-4）：单实例锁——双开时两个主进程各自持有 SettingsStore
// 内存态，tmp+rename 原子写互相覆盖（先写一方的设置变更丢失）、usage.jsonl
// 双进程追加、MCP/LSP 子进程双份。第二实例直接退出并聚焦已有窗口。
// （E2E 用 DEVWIT_USER_DATA_DIR 独立 userData，不与用户实例撞锁。）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
      // completed + contextTourSeen + authGateTourSeen：抑制向导与全部首次导览
      // （上下文/授权门，D2），避免任何遮罩挡住既有 E2E 首击目标。
      settings.set("onboarding.state", { completed: true, contextTourSeen: true, authGateTourSeen: true });
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
  const updaterInstance = new UpdateService({ send, isPackaged: app.isPackaged, ...(fakeUpdate !== undefined ? { fakeSequence: fakeUpdate } : {}) });
  updater = updaterInstance;

  // AI 子系统（WU008-WU012 接线）：manifest 落盘 userData/manifests（AC2 审计产物）
  // v0.7.5：grep 正则匹配经 worker 线程隔离（ReDoS 硬超时），env 注入端口
  const matcher = new RegexMatchService();
  regexMatcher = matcher;
  const toolEnv = {
    ...createNodeEnvironment(),
    matchRegexLines: (lines: readonly string[], source: string, flags: string) =>
      matcher.match(lines, source, flags),
  };
  const ai = new AiRuntime({
    settings,
    workspace,
    send,
    env: toolEnv,
    manifestsDir: path.join(app.getPath("userData"), "manifests"),
  });
  aiRuntime = ai;

  // LSP 代码智能（迭代 31 / AC40）：工作区打开（IPC 层钩子）即启动 tsserver；
  // ELECTRON_RUN_AS_NODE 复用 Electron 二进制，用户机器零系统依赖。
  lspService = new LspService({ send });

  // Git 版本控制（迭代 32 / AC41）：工作区打开钩子换绑仓库根；操作后推送 git:changed。
  const gitService = new GitMainService({ send });

  // DAP 调试（迭代 33 / AC42）：js-debug 适配器全局单例会话；
  // ELECTRON_RUN_AS_NODE 复用 Electron 二进制跑适配器与被调试进程，零系统依赖。
  debugService = new DebugMainService({ send });

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
    lsp: lspService,
    git: gitService,
    debug: debugService,
    telemetry: telemetry ?? undefined,
  });

  createWindow();

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

app.on("will-quit", (event) => {
  // v0.7.23 修复（审查 R7-3）：异步清理必须真正完成后再退出——旧实现全部
  // fire-and-forget，will-quit 同步返回后进程即退出：MCP 第 2..N 个 stdio
  // server 的 kill、LSP 的 3s 强杀、DAP 的 debuggee.kill、遥测 flush 全部
  // 不及执行（配置多服务器时孤儿进程驻留）。preventDefault + 等待全部清理
  // （各 dispose 自带 3s 上限）后显式退出；重复进入时直接放行。
  if (quitCleanupStarted) {
    return;
  }
  quitCleanupStarted = true;
  event.preventDefault();
  terminal?.disposeAll();
  workspace?.close();
  regexMatcher?.dispose();
  void (async () => {
    const jobs: Array<Promise<unknown>> = [];
    // AC17：退出前停止全部 MCP 子进程，避免孤儿进程驻留
    if (aiRuntime !== null) jobs.push(aiRuntime.dispose());
    // AC40：退出前 LSP shutdown 请求 → exit 通知 → 超时强杀（同 MCP 口径，零孤儿进程）
    if (lspService !== null) jobs.push(lspService.shutdown());
    // AC42：退出前 DAP disconnect + 强杀 js-debug 服务器（零孤儿进程）
    if (debugService !== null) jobs.push(debugService.shutdown());
    // AC39：退出前尽力 flush 残余遥测缓冲（5s 超时上限在 service 内）
    if (telemetry !== null) jobs.push(telemetry.stop());
    // 单项兜底 4s（dispose 内部各有 3s 上限，此处防未知挂起拖住退出）
    await Promise.all(
      jobs.map((job) => Promise.race([job, new Promise((resolve) => setTimeout(resolve, 4000))]))
    );
    app.exit(0);
  })();
});

/** will-quit 清理已启动标记（防止 preventDefault 后二次进入重复清理）。 */
let quitCleanupStarted = false;

/** 静默更新检查已发起标记（v0.7.26 / R7-8：reload/多窗口不重复检查）。 */
let updaterStarted = false;
