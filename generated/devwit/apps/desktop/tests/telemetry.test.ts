/**
 * TelemetryService 单测（迭代 30 / AC39）：opt-in 门控 / 匿名 installId /
 * 缓冲批量发送 / 失败静默 / 热重配置。
 *
 * 不用 mock 框架：真实 SettingsStore（NodeCryptoBackend）+ 真实 tmp 目录落盘，
 * 唯一注入边界是 fetch（记录桩）——与 ai-runtime-trace.test.ts 同口径。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import { TelemetryService } from "../src/main/telemetry.js";
import type { TelemetryFetch } from "../src/main/telemetry.js";

interface SentBatch {
  url: string;
  /** 原始请求体（PostHog 信封用独立类型解析，避免污染既有自建信封断言）。 */
  raw: string;
  body: { source: string; events: TelemetryEvent[] };
}

/** PostHog /batch/ 官方信封（内建默认端点）。 */
interface PostHogBatch {
  api_key: string;
  batch: Array<{
    event: string;
    distinct_id: string;
    timestamp: string;
    properties: Record<string, unknown>;
  }>;
}

/** 记录桩：捕获每次 flush 的 url 与解析后的 JSON body；可脚本化抛错。 */
function makeFetchStub() {
  const batches: SentBatch[] = [];
  let failNext = false;
  const fetchImpl: TelemetryFetch = async (url, init) => {
    if (failNext) {
      failNext = false;
      throw new Error("network down");
    }
    batches.push({ url, raw: init.body, body: JSON.parse(init.body) as SentBatch["body"] });
  };
  return {
    batches,
    fetchImpl,
    failOnce: () => {
      failNext = true;
    },
  };
}

let tmpRoot = "";

function makeService(
  stub: ReturnType<typeof makeFetchStub>,
  overrides: { flushMs?: number } = {}
): { service: TelemetryService; settings: SettingsStore } {
  const settings = new SettingsStore(new NodeCryptoBackend(), path.join(tmpRoot, "settings"));
  const service = new TelemetryService({
    settings,
    version: "0.3.0-test",
    os: "win32",
    fetchImpl: stub.fetchImpl,
    ...(overrides.flushMs !== undefined ? { flushMs: overrides.flushMs } : {}),
  });
  return { service, settings };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-ac39-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("TelemetryService（迭代 30 / AC39）", () => {
  it("默认关闭：从未配置时 start/track 均不发送任何字节", async () => {
    const stub = makeFetchStub();
    const { service } = makeService(stub);
    service.start();
    service.track("app_start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.batches).toEqual([]);
    expect(service.pendingCount).toBe(0); // 未激活直接丢弃，不缓冲
    service.stop();
  });

  it("开启但端点为空：走内建 PostHog 端点（api_key + batch 官方信封）", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub);
    settings.set("telemetry", { enabled: true, endpoint: "" });
    service.configure(); // 关→开：telemetry_opt_in 立即 flush
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stub.batches.length).toBeGreaterThanOrEqual(1);
    const first = stub.batches[0]!;
    expect(first.url).toBe("https://us.i.posthog.com/batch/");
    const envelope = JSON.parse(first.raw) as PostHogBatch;
    expect(envelope.api_key).toMatch(/^phc_/);
    expect(envelope.batch.length).toBeGreaterThanOrEqual(1);
    const names = envelope.batch.map((e) => e.event);
    expect(names).toContain("install");
    expect(names).toContain("telemetry_opt_in");
    for (const event of envelope.batch) {
      expect(event.distinct_id).toMatch(/^[0-9a-f-]{36}$/); // 匿名 installId，与账号无关
      expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
      // 零内容硬断言：properties 仅 source/version/os 标量
      expect(event.properties).toEqual({ source: "devwit", version: "0.3.0-test", os: "win32" });
    }
    service.stop();
  });

  it("开启 + 端点：start 发送 app_start，载荷仅 事件名/ts/installId/version/os（零内容字段）", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub);
    settings.set("telemetry", { enabled: true, endpoint: "https://telemetry.example/ingest" });
    service.configure(); // 关→开：telemetry_opt_in 立即 flush
    service.start(); // app_start
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stub.batches.length).toBeGreaterThanOrEqual(1);
    const events = stub.batches.flatMap((batch) => batch.body.events);
    expect(events.map((event) => event.event)).toEqual([
      "install",
      "telemetry_opt_in",
      "session_start",
      "app_start",
    ]);
    expect(stub.batches[0]!.url).toBe("https://telemetry.example/ingest");
    expect(stub.batches[0]!.body.source).toBe("devwit");
    for (const event of events) {
      // 形状硬断言：仅允许这 5 个键（+ 可选 props），绝无内容字段
      expect(Object.keys(event).sort()).toEqual(["event", "installId", "os", "ts", "version"]);
      expect(event.version).toBe("0.3.0-test");
      expect(event.os).toBe("win32");
      expect(event.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    }
    service.stop();
  });

  it("installId 跨实例复用（同 settings 目录模拟重启），不同目录互不相同", async () => {
    const stub = makeFetchStub();
    const { service: s1, settings } = makeService(stub);
    settings.set("telemetry", { enabled: true, endpoint: "https://t.example/x" });
    s1.configure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id1 = stub.batches[0]!.body.events[0]!.installId;
    s1.stop();

    // 新实例 = 模拟重启：installId 从 settings 读回，不重新生成
    const service2 = new TelemetryService({
      settings,
      version: "0.3.0-test",
      os: "win32",
      fetchImpl: stub.fetchImpl,
    });
    service2.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const id2 = stub.batches.at(-1)!.body.events[0]!.installId;
    expect(id2).toBe(id1);
    service2.stop();

    // installId 真实落盘 settings.json（重启持久化的证据）
    const onDisk = JSON.parse(readFileSync(path.join(tmpRoot, "settings", "settings.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(onDisk["telemetry.installId"]).toBe(id1);
  });

  it("热重配置：开启收到 opt_in；关闭收到 opt_out 后停止；端点变更清空积压", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub);
    service.start(); // 默认关：静默
    settings.set("telemetry", { enabled: true, endpoint: "https://t.example/a" });
    service.configure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.batches.flatMap((b) => b.body.events).map((e) => e.event)).toEqual([
      "install",
      "telemetry_opt_in",
    ]);

    settings.set("telemetry", { enabled: false, endpoint: "https://t.example/a" });
    service.configure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const names = stub.batches.flatMap((b) => b.body.events).map((e) => e.event);
    expect(names).toEqual(["install", "telemetry_opt_in", "telemetry_opt_out"]);

    // 关闭后 track 直接丢弃
    const sentBefore = stub.batches.flatMap((b) => b.body.events).length;
    service.track("app_start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stub.batches.flatMap((b) => b.body.events).length).toBe(sentBefore);
    service.stop();
  });

  it("发送失败静默丢弃：不抛错、不重试、缓冲不累积，恢复后可继续发送", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub, { flushMs: 10 });
    settings.set("telemetry", { enabled: true, endpoint: "https://t.example/a" });
    service.configure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const okBatches = stub.batches.length;
    expect(okBatches).toBeGreaterThanOrEqual(1);

    stub.failOnce();
    service.track("app_start");
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等周期 flush 触发失败
    expect(service.pendingCount).toBe(0); // 失败也丢弃，不累积

    service.track("app_start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stub.batches.length).toBeGreaterThan(okBatches); // 恢复后正常发送
    service.stop();
  });

  it("周期 flush：缓冲事件按 flushMs 间隔批量发出", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub, { flushMs: 15 });
    settings.set("telemetry", { enabled: true, endpoint: "https://t.example/a" });
    service.configure();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterOptIn = stub.batches.flatMap((b) => b.body.events).length;

    service.track("app_start");
    service.track("app_start"); // 同名计数场景：两条事件独立入批
    await new Promise((resolve) => setTimeout(resolve, 60)); // 覆盖 ≥1 个周期
    const total = stub.batches.flatMap((b) => b.body.events).length;
    expect(total).toBe(afterOptIn + 2);
    service.stop();
  });

  it("配置键非法形状按默认关闭处理（损坏配置不发送、不抛错）", () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub);
    settings.set("telemetry", "garbage-string");
    service.configure();
    service.start();
    service.track("app_start");
    expect(service.isActive()).toBe(false);
    expect(stub.batches).toEqual([]);
    service.stop();
  });

  it("R4：install 只发一次；trackActivate 在 opt-in 下只发一次", async () => {
    const stub = makeFetchStub();
    const { service, settings } = makeService(stub);
    settings.set("telemetry", { enabled: true, endpoint: "https://t.example/a" });
    service.configure();
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterStart = stub.batches.flatMap((b) => b.body.events).map((e) => e.event);
    expect(afterStart.filter((e) => e === "install")).toHaveLength(1);
    expect(afterStart).toContain("session_start");

    service.start(); // 二次 start：不应再发 install
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      stub.batches.flatMap((b) => b.body.events).filter((e) => e.event === "install")
    ).toHaveLength(1);

    service.trackActivate();
    service.trackActivate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      stub.batches.flatMap((b) => b.body.events).filter((e) => e.event === "activate")
    ).toHaveLength(1);
    service.stop();
  });
});
