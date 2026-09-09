/**
 * 正则匹配 worker 服务（v0.7.5：agent grep 的 ReDoS 隔离）。
 *
 * grep 工具的 LLM 可控正则在主进程逐行 test——灾难性回溯会挂死主进程。
 * 本服务把匹配执行移入与工作区搜索共用的 worker（search-worker.mjs 的
 * match-lines 操作），并作为 ToolEnvironment.matchRegexLines 注入：
 * - 常驻单 worker + 请求串行化（worker 冷启动 ~30ms，逐 grep 复用）；
 * - 每请求硬超时（默认 10s）：超时 terminate 该 worker 并按需重建——
 *   灾难性正则只损失等待时长，主进程无恙；
 * - 空闲 60s 自动回收（不驻留线程）；
 * - 一切异常路径返回 null（调用方按工具失败处理，绝不抛穿主进程）。
 */
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./search-worker.mjs", import.meta.url);
const DEFAULT_MATCH_TIMEOUT_MS = 10_000;
const IDLE_RECYCLE_MS = 60_000;

export class RegexMatchService {
  private worker: Worker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** 串行队列：单 worker 一次只处理一个请求（超时语义才可判定归属）。 */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param workerUrl worker 模块 URL（缺省指向打包产物；测试注入 tsc 产物/fixture）。 */
  constructor(
    private readonly workerUrl: URL | string = WORKER_URL
  ) {}

  /**
   * 逐行正则匹配（worker 线程执行）。中止/超时/崩溃一律 resolve(null)。
   * 行数组经结构化克隆传递（大文件批量的传输成本远低于正则灾难回溯风险）。
   */
  match(
    lines: readonly string[],
    source: string,
    flags: string,
    timeoutMs: number = DEFAULT_MATCH_TIMEOUT_MS
  ): Promise<boolean[] | null> {
    const run = (): Promise<boolean[] | null> => this.dispatch(lines, source, flags, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** 退出/停机回收（will-quit 钩子；空闲回收之外的双保险）。 */
  dispose(): void {
    this.clearIdleTimer();
    if (this.worker !== null) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private dispatch(
    lines: readonly string[],
    source: string,
    flags: string,
    timeoutMs: number
  ): Promise<boolean[] | null> {
    return new Promise((resolve) => {
      const finish = (value: boolean[] | null): void => {
        clearTimeout(timer);
        settled = true;
        // 崩溃/超时的 worker 不可信：立即废弃，下次请求重建
        if (this.worker !== null) {
          void this.worker.terminate();
          this.worker = null;
        }
        resolve(value);
      };
      let settled = false;
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => finish(null), timeoutMs);
      const onMessage = (message: { ok: boolean; matched?: boolean[] }): void => {
        if (settled) return;
        if (message.ok && Array.isArray(message.matched)) {
          const matched = message.matched;
          // 正常完成：worker 保留复用，仅重置空闲计时
          clearTimeout(timer);
          settled = true;
          this.armIdleTimer();
          worker.off("message", onMessage);
          worker.off("error", onError);
          resolve(matched);
        } else {
          finish(null);
        }
      };
      const onError = (): void => finish(null);
      worker.on("message", onMessage);
      worker.on("error", onError);
      // worker 无 error 事件的主动退出（如 OOM/process.exit）：非零码且未决 → 失败
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(null);
      });
      worker.postMessage({ id: 1, op: "match-lines", lines, source, flags });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) {
      this.clearIdleTimer();
      return this.worker;
    }
    const worker = new Worker(this.workerUrl);
    this.worker = worker;
    return worker;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker !== null) {
        void this.worker.terminate();
        this.worker = null;
      }
    }, IDLE_RECYCLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
