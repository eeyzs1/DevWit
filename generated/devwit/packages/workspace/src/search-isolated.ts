/**
 * 工作区搜索的 worker 隔离包装（v0.7.4：主进程 ReDoS 修复）。
 *
 * searchInWorkspace 在主进程执行用户/LLM 提供的正则——灾难性回溯可无限期
 * 挂死主进程。本包装把执行移入 worker 线程并施加硬超时：超时 terminate +
 * 抛 SearchTimeoutError（DW_SEARCH_TIMEOUT），主进程最坏只损失等待时长。
 *
 * 正则合法性仍在本线程先编译（保持原有「非法正则同步抛 SyntaxError」语义，
 * 不为合法校验付出一次线程往返）。worker URL 由调用方注入（apps 层指向打包
 * 产物 search-worker.mjs；测试指向 fixture）——包不感知打包布局。
 */
import { Worker } from "node:worker_threads";
import { compileSearchRegex, searchInWorkspace, type SearchOptions, type SearchResults } from "./search.js";

export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;

/** 搜索超时（worker 已被 terminate，主进程恢复响应）。 */
export class SearchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`DW_SEARCH_TIMEOUT:${timeoutMs}`);
    this.name = "SearchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** worker 启动/崩溃（产物缺失或运行时异常）。 */
export class SearchWorkerError extends Error {
  constructor(detail: string) {
    super(`DW_SEARCH_WORKER_FAILED:${detail}`);
    this.name = "SearchWorkerError";
  }
}

/**
 * 隔离执行搜索：worker 线程内跑 searchInWorkspace，主线程仅等待（带超时）。
 * @param workerUrl worker 模块 URL（file URL 或路径）
 */
export function searchInWorkspaceIsolated(
  rootPath: string,
  options: SearchOptions,
  workerUrl: URL | string,
  timeoutMs: number = DEFAULT_SEARCH_TIMEOUT_MS
): Promise<SearchResults> {
  // 主线程先行编译：非法正则保持同步抛出（与直接调用 searchInWorkspace 同语义）
  compileSearchRegex(options);
  return new Promise<SearchResults>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl);
    } catch (error) {
      reject(new SearchWorkerError(error instanceof Error ? error.message : String(error)));
      return;
    }
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new SearchTimeoutError(timeoutMs)));
    }, timeoutMs);
    worker.on("message", (message: { id: number; ok: boolean; results?: SearchResults; error?: string }) => {
      if (message.ok) {
        const results = message.results;
        if (results !== undefined) {
          finish(() => resolve(results));
        }
      } else {
        finish(() => reject(new Error(message.error ?? "DW_SEARCH_WORKER_FAILED:unknown")));
      }
    });
    worker.on("error", (error) => {
      finish(() => reject(new SearchWorkerError(error.message)));
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new SearchWorkerError(`exit:${code}`)));
      }
    });
    worker.postMessage({ id: 1, root: rootPath, options });
  });
}

// 重新导出非隔离实现（ipc 层与既有测试仍可直用；隔离版仅替换执行位置）
export { searchInWorkspace };
