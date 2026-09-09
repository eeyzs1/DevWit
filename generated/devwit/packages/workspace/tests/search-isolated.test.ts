/**
 * searchInWorkspaceIsolated（v0.7.4：worker 隔离）真实回环测试。
 * - 真实 worker：tsc 产物 dist/search-worker.js（CI/本地流程均先 tsc -b 后测试）
 *   ——与直接调用 searchInWorkspace 的结果逐字段一致；
 * - 挂死 fixture：超时 terminate + DW_SEARCH_TIMEOUT（主进程不被灾难性正则拖死）；
 * - 非法正则在主线程同步抛出（语义与直接调用一致，不付出线程往返）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { searchInWorkspace, searchInWorkspaceIsolated, SearchTimeoutError } from "../src/search-isolated.js";

const REAL_WORKER = new URL("../dist/search-worker.js", import.meta.url);
const HANG_WORKER = new URL("./fixtures/search-worker-hang.mjs", import.meta.url);

describe("searchInWorkspaceIsolated（worker 隔离）", () => {
  it("真实 worker 执行搜索：结果与主进程直接执行完全一致", async () => {
    if (!fs.existsSync(fileURLToPath(REAL_WORKER))) {
      throw new Error("dist/search-worker.js 缺失——先运行 tsc -b（构建链已保证）");
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-iso-search-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "a.ts"), "const hello = 1;\nconst world = hello + 2;\n");
      fs.writeFileSync(path.join(root, "b.md"), "hello in markdown\n");
      const options = { query: "hello", isRegex: false, caseSensitive: false, wholeWord: false };
      const [direct, isolated] = await Promise.all([
        searchInWorkspace(root, options),
        searchInWorkspaceIsolated(root, options, REAL_WORKER),
      ]);
      expect(isolated).toEqual(direct);
      expect(isolated.totalMatches).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("挂死的 worker：超时 terminate 并抛 DW_SEARCH_TIMEOUT（主进程恢复响应）", async () => {
    const started = Date.now();
    await expect(
      searchInWorkspaceIsolated(
        "C:\\whatever",
        { query: "x", isRegex: false, caseSensitive: true, wholeWord: false },
        HANG_WORKER,
        300
      )
    ).rejects.toBeInstanceOf(SearchTimeoutError);
    // 超时在配置值附近生效（不是立即失败=worker 正常启动并被计时终止）
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("灾难性回溯正则（ReDoS 样本）：隔离执行被硬超时终止而非挂死进程", async () => {
    // 经典灾难性回溯：(a+)+$ 对 'a'.repeat(28)+'!' 需指数时间
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-redos-"));
    try {
      fs.writeFileSync(path.join(root, "evil.txt"), "a".repeat(28) + "!");
      await expect(
        searchInWorkspaceIsolated(
          root,
          { query: "(a+)+$", isRegex: true, caseSensitive: true, wholeWord: false },
          REAL_WORKER,
          2_000
        )
      ).rejects.toBeInstanceOf(SearchTimeoutError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("非法正则在主线程同步拒绝（保持原 SyntaxError 语义，不启动 worker）", () => {
    expect(() =>
      searchInWorkspaceIsolated(
        "C:\\x",
        { query: "([", isRegex: true, caseSensitive: false, wholeWord: false },
        HANG_WORKER,
        30_000
      )
    ).toThrow(SyntaxError);
  });

  it("worker 产物缺失：启动失败抛 DW_SEARCH_WORKER_FAILED（可见错误，不静默）", async () => {
    await expect(
      searchInWorkspaceIsolated(
        "C:\\x",
        { query: "a", isRegex: false, caseSensitive: false, wholeWord: false },
        new URL("file:///./definitely-not-a-worker-module.mjs"),
        5_000
      )
    ).rejects.toThrow(/DW_SEARCH_WORKER_FAILED|MODULE_NOT_FOUND/);
  });
});
