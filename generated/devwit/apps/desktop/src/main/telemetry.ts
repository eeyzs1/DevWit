/**
 * 匿名遥测服务（迭代 30 / AC39）：opt-in、零内容、端点可配置的最小度量。
 *
 * 原则（与产品信任基建同口径）：
 * - 默认关闭：settings 键 "telemetry" 不存在 / enabled !== true / endpoint 为空，
 *   三者任一成立即不发送任何字节（track 直接丢弃，不缓冲）；
 * - 匿名：installId 为 crypto.randomUUID，首次需要时生成并持久化到
 *   settings 键 "telemetry.installId"，跨重启复用；与任何账号/机器标识无关；
 * - 零内容收集：事件载荷仅 事件名/ISO 时间/installId/版本/OS 平台/标量 props，
 *   事件名只能来自代码内固定字面量，无自由文本入口；
 * - 热生效：configure() 由 settings.onChanged 驱动，开关/端点修改即时生效；
 * - 绝不拖垮应用：发送失败静默丢弃（不重试、不累积、不抛错）；flush 有超时护栏。
 *
 * 本文件不 import electron——version/os 由 index.ts 注入，fetch 可注入替身，
 * vitest 可直接实例化（同 UpdateService 模式）。
 */
import { randomUUID } from "node:crypto";
import type { TelemetryConfig, TelemetryEvent } from "@devwit/contracts";

/** 设置读取/写入的结构子集（SettingsStore 满足）。 */
export interface TelemetrySettingsLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** fetch 的结构子集（node 全局 fetch 满足；测试注入记录桩）。 */
export type TelemetryFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<unknown>;

export interface TelemetryServiceDeps {
  settings: TelemetrySettingsLike;
  /** app.getVersion()。 */
  version: string;
  /** process.platform。 */
  os: string;
  /** 缺省为全局 fetch。 */
  fetchImpl?: TelemetryFetch;
  /** 周期 flush 间隔（缺省 30s；E2E 经 DEVWIT_TELEMETRY_FLUSH_MS 缩短）。 */
  flushMs?: number;
  /** 单次 flush 超时护栏（缺省 5s）。 */
  timeoutMs?: number;
}

const CONFIG_KEY = "telemetry";
const INSTALL_ID_KEY = "telemetry.installId";
const DEFAULT_FLUSH_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
/** 缓冲上限：达到即提前 flush（防长会话无限累积）。 */
const BUFFER_FLUSH_AT = 20;

function readConfig(settings: TelemetrySettingsLike): TelemetryConfig {
  const raw = settings.get(CONFIG_KEY);
  if (typeof raw !== "object" || raw === null) return { enabled: false, endpoint: "" };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r["enabled"] === true,
    endpoint: typeof r["endpoint"] === "string" ? r["endpoint"] : "",
  };
}

export class TelemetryService {
  private readonly settings: TelemetrySettingsLike;
  private readonly fetchImpl: TelemetryFetch;
  private readonly flushMs: number;
  private readonly timeoutMs: number;
  private config: TelemetryConfig;
  private installId: string | null = null;
  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly deps: TelemetryServiceDeps) {
    this.settings = deps.settings;
    this.fetchImpl =
      deps.fetchImpl ??
      (async (url, init) => {
        await fetch(url, init);
      });
    this.flushMs = deps.flushMs ?? DEFAULT_FLUSH_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.config = readConfig(this.settings);
  }

  /** 启动：已开启（含端点）时记录 app_start 并启动周期 flush；默认关闭则完全静默。 */
  start(): void {
    if (!this.isActive()) return;
    this.arm();
    this.track("app_start");
    void this.flush();
  }

  /**
   * 热重配置（settings.onChanged("telemetry") 驱动）。
   * 关→开：记录 telemetry_opt_in 并立即 flush；开→关：先记录 telemetry_opt_out
   * 并 flush（最后一条，透明告知），随后停表丢弃后续。
   */
  configure(): void {
    const wasActive = this.isActive();
    const next = readConfig(this.settings);
    const endpointChanged = next.endpoint !== this.config.endpoint;
    this.config = next;
    const nowActive = this.isActive();
    if (!wasActive && nowActive) {
      this.arm();
      this.track("telemetry_opt_in");
      void this.flush();
    } else if (wasActive && !nowActive) {
      // 先以旧激活态把 opt_out 发出去，再停（isActive 现已为 false，直接构造事件）
      this.buffer.push(this.buildEvent("telemetry_opt_out"));
      void this.flush();
      this.disarm();
    } else if (nowActive && endpointChanged) {
      // 端点变更：积压事件发往何处属旧配置的语义，先清空再续（宁缺毋滥）
      this.buffer = [];
    }
  }

  /** 记录事件（事件名固定字面量；未激活直接丢弃，不缓冲）。 */
  track(event: string, props?: Record<string, string | number | boolean>): void {
    if (!this.isActive()) return;
    this.buffer.push(this.buildEvent(event, props));
    if (this.buffer.length >= BUFFER_FLUSH_AT) void this.flush();
  }

  /** 退出前尽力 flush（void 调用，不阻塞 will-quit）。 */
  stop(): void {
    this.disarm();
    void this.flush();
  }

  /** 当前是否激活（开启 + 端点非空，双条件缺一不发）。 */
  isActive(): boolean {
    return this.config.enabled && this.config.endpoint.trim() !== "";
  }

  /** 当前缓冲长度（测试观测用）。 */
  get pendingCount(): number {
    return this.buffer.length;
  }

  private buildEvent(event: string, props?: Record<string, string | number | boolean>): TelemetryEvent {
    return {
      event,
      ts: new Date().toISOString(),
      installId: this.ensureInstallId(),
      version: this.deps.version,
      os: this.deps.os,
      ...(props !== undefined ? { props } : {}),
    };
  }

  /** installId 惰性生成并持久化；同一 settings 目录跨实例/跨重启复用。 */
  private ensureInstallId(): string {
    if (this.installId !== null) return this.installId;
    const existing = this.settings.get(INSTALL_ID_KEY);
    if (typeof existing === "string" && existing !== "") {
      this.installId = existing;
      return existing;
    }
    const generated = randomUUID();
    this.settings.set(INSTALL_ID_KEY, generated);
    this.installId = generated;
    return generated;
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.(); // 遥测计时器绝不阻止进程退出
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 批量 POST；失败静默丢弃（不重试不累积）。并发 flush 合并为空操作。 */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    const endpoint = this.config.endpoint.trim();
    if (endpoint === "" || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.flushing = true;
    try {
      await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "devwit", events: batch }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // 静默丢弃：遥测永远不得影响应用本体（网络不可达/端点错误均属常态）
    } finally {
      this.flushing = false;
      // flush 进行期间新入缓冲的事件（并发 track / opt_out 接力）：立即再发一轮，
      // 否则要等下个周期——关闭前的 opt_out 可能因此丢失
      if (this.buffer.length > 0) void this.flush();
    }
  }
}
