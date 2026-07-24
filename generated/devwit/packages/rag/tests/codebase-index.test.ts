import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Embedder, RagStatusInfo } from "@devwit/contracts";
import { CodebaseIndex, cosineSimilarity, walkIndexableFiles } from "../src/codebase-index.js";

/**
 * 确定性关键词 embedder：词表固定 8 维，含关键词则该维为 1。
 * 让"login"查询命中登录代码而非无关代码，相似度语义可断言。
 */
const VOCAB = ["login", "auth", "user", "token", "database", "query", "render", "button"];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
}

function makeEmbedder(calls?: { count: number }): Embedder {
  return {
    model: "fake-embed",
    embed: async (texts: string[]) => {
      if (calls !== undefined) calls.count += texts.length;
      return texts.map(fakeVector);
    },
  };
}

const naiveCount = (text: string): number => Math.ceil(text.length / 4);

describe("cosineSimilarity", () => {
  it("正交为 0，同向为 1，维度不等为 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("walkIndexableFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-rag-walk-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("枚举代码文件，排除 node_modules / dist / 非白名单扩展", async () => {
    fs.writeFileSync(path.join(root, "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(root, "b.png"), "binary");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "c.ts"), "const c = 1;");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "d.py"), "x = 1");

    const found = await walkIndexableFiles(root);
    const rels = found.map((f) => f.relPath.replaceAll("\\", "/")).sort();
    expect(rels).toEqual(["a.ts", "src/d.py"]);
  });
});

describe("CodebaseIndex", () => {
  let root: string;
  let indexDir: string;
  let statuses: RagStatusInfo[];

  const onStatus = (s: RagStatusInfo): void => {
    statuses.push(s);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-rag-root-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-rag-idx-"));
    statuses = [];
    fs.writeFileSync(
      path.join(root, "login.ts"),
      ["export function login(user, token) {", "  // auth user with token", "  return check(user, token);", "}"].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "button.ts"),
      ["export function renderButton() {", "  // render a button widget", "  return dom;", "}"].join("\n")
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("buildAll 后状态 ready，状态流含 indexing 进度", async () => {
    const index = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder(), onStatus });
    await index.buildAll();
    const status = index.getStatus();
    expect(status.state).toBe("ready");
    if (status.state === "ready") {
      expect(status.fileCount).toBe(2);
      expect(status.chunkCount).toBeGreaterThanOrEqual(2);
    }
    expect(statuses.some((s) => s.state === "indexing")).toBe(true);
    expect(statuses.at(-1)!.state).toBe("ready");
  });

  it("二次 buildAll 无变更时零 embedding 请求（持久化恢复 + mtime 检测）", async () => {
    const first = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder() });
    await first.buildAll();
    first.dispose();

    const calls = { count: 0 };
    const second = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder(calls) });
    await second.buildAll();
    expect(calls.count).toBe(0);
    expect(second.getStatus().state).toBe("ready");
    expect(second.chunkCount).toBeGreaterThanOrEqual(2);
  });

  it("query 返回相关命中（login 查询命中 login.ts，不命中 button.ts）", async () => {
    const index = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder() });
    await index.buildAll();
    const hits = await index.query("login auth token", { topK: 5, budgetTokens: 10000, countTokens: naiveCount });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.relPath).toBe("login.ts");
    expect(hits[0]!.score).toBeGreaterThan(0);
    // 按分数降序
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });

  it("query 遵守 topK 与 token 预算截断", async () => {
    const index = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder() });
    await index.buildAll();
    const top1 = await index.query("login", { topK: 1, budgetTokens: 10000, countTokens: naiveCount });
    expect(top1).toHaveLength(1);
    // 预算为 1 token：首块必给（picked.length === 0 不截断），后续全截断
    const tiny = await index.query("login", { topK: 5, budgetTokens: 1, countTokens: naiveCount });
    expect(tiny).toHaveLength(1);
  });

  it("syncFile 同步变更：改文件后命中新内容，删文件后块移除", async () => {
    const index = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder() });
    await index.buildAll();

    // 改 button.ts 为 login 相关 → 应能被 login 查询命中
    const buttonPath = path.join(root, "button.ts");
    fs.writeFileSync(buttonPath, ["export function loginButton(user, token) {", "  // login via button", "  return go(user, token);", "}"].join("\n"));
    // mtime 精度兜底：确保 mtime/size 变化被检测
    await index.syncFile(buttonPath);
    const hits = await index.query("login token", { topK: 10, budgetTokens: 10000, countTokens: naiveCount });
    expect(hits.some((h) => h.relPath === "button.ts")).toBe(true);

    // 删除 login.ts → 其块移除
    fs.rmSync(path.join(root, "login.ts"));
    await index.syncFile(path.join(root, "login.ts"));
    const after = await index.query("login token", { topK: 10, budgetTokens: 10000, countTokens: naiveCount });
    expect(after.every((h) => h.relPath !== "login.ts")).toBe(true);
    expect(index.fileCount).toBe(1);
  });

  it("embedding 失败 → 状态 error 且不 throw；队列自愈后 syncFile 仍可执行", async () => {
    let fail = true;
    const flaky: Embedder = {
      model: "flaky",
      embed: async (texts: string[]) => {
        if (fail) throw new Error("DW_LLM_TIMEOUT: simulated");
        return texts.map(fakeVector);
      },
    };
    const index = new CodebaseIndex({ root, indexDir, embedder: flaky, onStatus });
    await index.buildAll(); // 不 throw
    const status = index.getStatus();
    expect(status.state).toBe("error");
    if (status.state === "error") expect(status.code).toBe("DW_LLM_TIMEOUT");

    // 恢复后全量重建成功（队列未被失败毒化）
    fail = false;
    await index.buildAll();
    expect(index.getStatus().state).toBe("ready");
  });

  it("dispose 后状态归 disabled，磁盘索引保留", async () => {
    const index = new CodebaseIndex({ root, indexDir, embedder: makeEmbedder() });
    await index.buildAll();
    index.dispose();
    expect(index.getStatus().state).toBe("disabled");
    expect(fs.existsSync(path.join(indexDir, "chunks.jsonl"))).toBe(true);
  });
});
