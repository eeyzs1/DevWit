/**
 * UpdateService 单元测试（AC16）：
 * 纯 node 环境运行——updater.ts 不 import electron，AutoUpdaterLike 经依赖注入替身。
 * 覆盖：dev 禁用 / 打包环境事件映射 / 加载失败与检查失败降级 / E2E 合成序列回放 / install 语义。
 */
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@devwit/contracts";
import type { UpdateStatusInfo } from "@devwit/contracts";
import { UpdateService } from "../src/main/updater.js";
import type { AutoUpdaterLike } from "../src/main/updater.js";

/** AutoUpdaterLike 测试替身：事件注册表 + 触发器。 */
function fakeAutoUpdater(): AutoUpdaterLike & {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  trigger(event: string, ...args: unknown[]): void;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const au = {
    autoDownload: false,
    allowPrerelease: false,
    listeners,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    }),
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    trigger(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return au as AutoUpdaterLike & {
    listeners: Map<string, Array<(...args: unknown[]) => void>>;
    trigger(event: string, ...args: unknown[]): void;
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
  };
}

function collect(): { statuses: UpdateStatusInfo[]; send: (channel: string, ...args: unknown[]) => void } {
  const statuses: UpdateStatusInfo[] = [];
  return {
    statuses,
    send: (channel: string, ...args: unknown[]) => {
      expect(channel).toBe(IPC.UpdateStatus);
      statuses.push(args[0] as UpdateStatusInfo);
    },
  };
}

describe("UpdateService（AC16）", () => {
  it("开发模式（isPackaged=false）start 只发 disabled，不加载 electron-updater", async () => {
    const { statuses, send } = collect();
    const loadAutoUpdater = vi.fn(async () => fakeAutoUpdater());
    const service = new UpdateService({ send, isPackaged: false, loadAutoUpdater });
    await service.start();
    expect(statuses).toEqual([{ state: "disabled" }]);
    expect(loadAutoUpdater).not.toHaveBeenCalled();
  });

  it("打包环境 start：配置 autoDownload/allowPrerelease 并发起检查，事件映射为状态序列", async () => {
    const { statuses, send } = collect();
    const au = fakeAutoUpdater();
    const service = new UpdateService({ send, isPackaged: true, loadAutoUpdater: async () => au });
    await service.start();
    expect(au.autoDownload).toBe(true);
    expect(au.allowPrerelease).toBe(true);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);

    au.trigger("checking-for-update");
    au.trigger("update-available", { version: "1.2.3" });
    au.trigger("download-progress", { percent: 41.6 });
    au.trigger("update-downloaded", { version: "1.2.3" });
    expect(statuses.slice(-4)).toEqual([
      { state: "checking" },
      { state: "available", version: "1.2.3" },
      { state: "downloading", percent: 42 },
      { state: "ready", version: "1.2.3" },
    ]);
  });

  it("update-not-available → none；error 事件 → error(DW_UPDATE_CHECK_FAILED)", async () => {
    const { statuses, send } = collect();
    const au = fakeAutoUpdater();
    const service = new UpdateService({ send, isPackaged: true, loadAutoUpdater: async () => au });
    await service.start();
    au.trigger("update-not-available");
    au.trigger("error", new Error("net down"));
    expect(statuses.slice(-2)).toEqual([{ state: "none" }, { state: "error", code: "DW_UPDATE_CHECK_FAILED" }]);
  });

  it("checkForUpdates 拒绝（无 latest.yml / 网络不可达）→ error 状态，不抛出", async () => {
    const { statuses, send } = collect();
    const au = fakeAutoUpdater();
    au.checkForUpdates.mockRejectedValue(new Error("404 latest.yml"));
    const service = new UpdateService({ send, isPackaged: true, loadAutoUpdater: async () => au });
    await service.start();
    expect(statuses).toContainEqual({ state: "error", code: "DW_UPDATE_CHECK_FAILED" });
  });

  it("electron-updater 加载失败（bundle 损坏）→ DW_UPDATE_LOAD_FAILED", async () => {
    const { statuses, send } = collect();
    const service = new UpdateService({
      send,
      isPackaged: true,
      loadAutoUpdater: async () => {
        throw new Error("broken bundle");
      },
    });
    await service.start();
    expect(statuses).toEqual([{ state: "error", code: "DW_UPDATE_LOAD_FAILED" }]);
  });

  it("开发模式手动 check：反馈 disabled（不静默吞掉）", async () => {
    const { statuses, send } = collect();
    const service = new UpdateService({ send, isPackaged: false, loadAutoUpdater: async () => fakeAutoUpdater() });
    await service.check();
    expect(statuses).toEqual([{ state: "disabled" }]);
  });

  it("E2E 合成序列：真实加载后按序回放；install() 显式空操作（防误触退出）", async () => {
    const { statuses, send } = collect();
    const au = fakeAutoUpdater();
    const loadAutoUpdater = vi.fn(async () => au);
    const fakeSequence: UpdateStatusInfo[] = [
      { state: "checking" },
      { state: "available", version: "9.9.9" },
      { state: "ready", version: "9.9.9" },
    ];
    const service = new UpdateService({ send, isPackaged: false, fakeSequence, loadAutoUpdater });
    await service.start();
    expect(loadAutoUpdater).toHaveBeenCalledTimes(1); // 证明运行环境可加载 electron-updater
    expect(statuses).toEqual(fakeSequence);
    expect(au.checkForUpdates).not.toHaveBeenCalled(); // 合成模式不联网
    service.install();
    expect(au.quitAndInstall).not.toHaveBeenCalled(); // 合成模式不退出应用
  });

  it("打包环境 install() 转发 quitAndInstall", async () => {
    const { send } = collect();
    const au = fakeAutoUpdater();
    const service = new UpdateService({ send, isPackaged: true, loadAutoUpdater: async () => au });
    await service.start();
    service.install();
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("install() 在 autoUpdater 未加载时为空操作（不抛错）", () => {
    const { send } = collect();
    const service = new UpdateService({ send, isPackaged: false });
    expect(() => service.install()).not.toThrow();
  });
});
