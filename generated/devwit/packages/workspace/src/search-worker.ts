/**
 * 工作区搜索 worker 入口（v0.7.4：主进程 ReDoS 修复）。
 *
 * 搜索在 Electron 主进程执行，灾难性回溯正则可无限期挂死主进程（全部 IPC/
 * UI 事件停摆）。本 worker 把执行隔离到独立线程：超时由包装侧 terminate 兜底，
 * 主进程最坏只损失 timeoutMs 的等待，不再被同步正则卡死。
 *
 * 打包：本文件由根 build:searchworker 独立 bundle 为
 * apps/desktop/dist/main/search-worker.mjs（node ESM worker）。
 * 协议：{ id, root, options } → { id, ok: true, results } | { id, ok: false, error }
 */
import { parentPort } from "node:worker_threads";
import { searchInWorkspace, type SearchOptions } from "./search.js";

const port = parentPort;
if (port !== null) {
  port.on("message", (message: { id: number; root: string; options: SearchOptions }) => {
    void searchInWorkspace(message.root, message.options)
      .then((results) => {
        port.postMessage({ id: message.id, ok: true, results });
      })
      .catch((error: unknown) => {
        port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      });
  });
}
