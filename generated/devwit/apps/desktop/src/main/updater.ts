/**
 * 自动更新服务（迭代 7 / AC16）：electron-updater 接 GitHub Releases。
 *
 * - 启动静默检查：仅打包环境（isPackaged）执行；开发/测试环境报 disabled 不打扰；
 * - 状态机经 send 推送渲染进程（checking/available/downloading/ready/none/error/disabled）；
 * - electron-updater 经动态 import 加载并 try/catch：打包产物中模块异常时降级为
 *   DW_UPDATE_LOAD_FAILED，绝不拖垮主进程；
 * - 本文件不 import electron——isPackaged/version 由 index.ts 注入，vitest 可直接实例化。
 */
import type { UpdateStatusInfo } from "@devwit/contracts";
import { IPC } from "@devwit/contracts";

/** electron-updater 的 autoUpdater 结构子集（依赖注入，测试可替身）。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  allowPrerelease: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateServiceDeps {
  /** 主→渲染推送（IPC.UpdateStatus 通道）。 */
  send: (channel: string, ...args: unknown[]) => void;
  /** app.isPackaged：开发模式为 false（跳过静默检查）。 */
  isPackaged: boolean;
  /**
   * E2E 钩子（DEVWIT_E2E_FAKE_UPDATE）：注入合成状态序列。
   * 仍会真实动态 import electron-updater 验证打包/ bundle 完整性，
   * 但不发起网络检查、不下载，install() 为空操作。
   */
  fakeSequence?: UpdateStatusInfo[];
  /** 测试注入的加载器；缺省为真实动态 import。 */
  loadAutoUpdater?: () => Promise<AutoUpdaterLike>;
}

export class UpdateService {
  private autoUpdater: AutoUpdaterLike | null = null;
  private checking = false;

  constructor(private readonly deps: UpdateServiceDeps) {}

  /** 启动静默检查（打包环境）或 E2E 合成序列回放。 */
  async start(): Promise<void> {
    if (this.deps.fakeSequence !== undefined) {
      await this.load(); // 证明 electron-updater 在运行环境中可加载（bundle 完整性）
    }
    if (!this.deps.isPackaged && this.deps.fakeSequence === undefined) {
      this.emit({ state: "disabled" });
      return;
    }
    await this.check();
  }

  /** 手动检查更新（设置页按钮）；与启动静默检查共用同一状态推送通道。 */
  async check(): Promise<void> {
    const fake = this.deps.fakeSequence;
    if (fake !== undefined) {
      // 合成模式：真实加载已验证，联网检查替换为序列回放（不下载、不安装）
      for (const status of fake) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.emit(status);
      }
      return;
    }
    if (!this.deps.isPackaged) {
      // 开发模式手动点击：明确反馈而非静默
      this.emit({ state: "disabled" });
      return;
    }
    if (this.checking) return; // 检查已在进行（启动检查与手动点击并发护栏）
    this.checking = true;
    try {
      const au = await this.load();
      if (au === null) {
        this.emit({ state: "error", code: "DW_UPDATE_LOAD_FAILED" });
        return;
      }
      try {
        await au.checkForUpdates();
      } catch {
        // 网络不可达 / Release 缺 latest.yml 等：状态条本地化提示，不抛 stderr 中文
        this.emit({ state: "error", code: "DW_UPDATE_CHECK_FAILED" });
      }
    } finally {
      this.checking = false;
    }
  }

  /** 下载完成后重启安装（fake 模式显式空操作：E2E 误触也不会退出应用）。 */
  install(): void {
    if (this.deps.fakeSequence !== undefined) return;
    this.autoUpdater?.quitAndInstall();
  }

  private async load(): Promise<AutoUpdaterLike | null> {
    if (this.autoUpdater !== null) return this.autoUpdater;
    const loader =
      this.deps.loadAutoUpdater ??
      (async (): Promise<AutoUpdaterLike> => {
        const mod = (await import("electron-updater")) as { autoUpdater: AutoUpdaterLike };
        return mod.autoUpdater;
      });
    try {
      const au = await loader();
      au.autoDownload = true; // 发现新版本即后台静默下载
      au.allowPrerelease = true; // Release 默认预发布（转正前也要能被检查到）
      au.on("checking-for-update", () => this.emit({ state: "checking" }));
      au.on("update-available", (info: unknown) => {
        const version = typeof (info as { version?: unknown })?.version === "string" ? (info as { version: string }).version : "";
        this.emit({ state: "available", version });
      });
      au.on("update-not-available", () => this.emit({ state: "none" }));
      au.on("download-progress", (progress: unknown) => {
        const percent = typeof (progress as { percent?: unknown })?.percent === "number" ? Math.round((progress as { percent: number }).percent) : 0;
        this.emit({ state: "downloading", percent });
      });
      au.on("update-downloaded", (info: unknown) => {
        const version = typeof (info as { version?: unknown })?.version === "string" ? (info as { version: string }).version : "";
        this.emit({ state: "ready", version });
      });
      au.on("error", () => this.emit({ state: "error", code: "DW_UPDATE_CHECK_FAILED" }));
      this.autoUpdater = au;
      return au;
    } catch {
      return null;
    }
  }

  private emit(status: UpdateStatusInfo): void {
    this.deps.send(IPC.UpdateStatus, status);
  }
}
