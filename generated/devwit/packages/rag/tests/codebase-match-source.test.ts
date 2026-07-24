import { describe, expect, it } from "vitest";
import type { ContextCollectInput } from "@devwit/contracts";
import type { CodebaseIndex, ScoredChunk } from "../src/codebase-index.js";
import { codebaseMatchSource } from "../src/codebase-match-source.js";

/** 最小输入构造（源只读 query）。 */
function input(query?: string): ContextCollectInput {
  return { conversationHistory: [], query };
}

const fakeCount = (text: string): number => Math.ceil(text.length / 4);

function fakeIndex(status: ReturnType<CodebaseIndex["getStatus"]>, hits?: ScoredChunk[]): CodebaseIndex {
  return {
    getStatus: () => status,
    query: async () => hits ?? [],
  } as unknown as CodebaseIndex;
}

describe("codebaseMatchSource", () => {
  it("无 query → 空列表", async () => {
    const source = codebaseMatchSource({ getIndex: () => null, topK: 5, budgetTokens: 1000, countTokens: fakeCount });
    expect(await source.collect(input(undefined))).toEqual([]);
    expect(await source.collect(input("   "))).toEqual([]);
  });

  it("索引 null → 占位项说明未启用", async () => {
    const source = codebaseMatchSource({ getIndex: () => null, topK: 5, budgetTokens: 1000, countTokens: fakeCount });
    const items = await source.collect(input("login"));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("codebase_match");
    expect(items[0]!.label).toContain("未启用");
    expect(items[0]!.key).toBeUndefined(); // 占位项无 key：仅受类型开关控制
  });

  it("索引构建中 → 占位项带进度", async () => {
    const source = codebaseMatchSource({
      getIndex: () => fakeIndex({ state: "indexing", indexedFiles: 3, totalFiles: 10 }),
      topK: 5,
      budgetTokens: 1000,
      countTokens: fakeCount,
    });
    const items = await source.collect(input("login"));
    expect(items[0]!.label).toContain("3/10");
  });

  it("索引错误 → 占位项带错误码", async () => {
    const source = codebaseMatchSource({
      getIndex: () => fakeIndex({ state: "error", code: "DW_RAG_NO_EMBED_PROVIDER" }),
      topK: 5,
      budgetTokens: 1000,
      countTokens: fakeCount,
    });
    const items = await source.collect(input("login"));
    expect(items[0]!.label).toContain("DW_RAG_NO_EMBED_PROVIDER");
  });

  it("ready + 命中 → 每块一个独立项：稳定 key、score、路径行区间在 label", async () => {
    const hit: ScoredChunk = {
      id: "chunk-1",
      relPath: "src/login.ts",
      startLine: 10,
      endLine: 20,
      text: "export function login() {}",
      score: 0.87,
    };
    const source = codebaseMatchSource({
      getIndex: () => fakeIndex({ state: "ready", fileCount: 1, chunkCount: 1 }, [hit]),
      topK: 5,
      budgetTokens: 1000,
      countTokens: fakeCount,
    });
    const items = await source.collect(input("login"));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.key).toBe("chunk-1"); // 逐项开关的 key
    expect(item.score).toBe(0.87);
    expect(item.label).toContain("src/login.ts");
    expect(item.label).toContain("L10-20");
    expect(item.label).toContain("0.870");
    expect(item.content).toBe(hit.text);
    expect(item.source).toBe("src/login.ts");
  });

  it("ready + 零命中 → 占位项说明无相关命中", async () => {
    const source = codebaseMatchSource({
      getIndex: () => fakeIndex({ state: "ready", fileCount: 5, chunkCount: 20 }, []),
      topK: 5,
      budgetTokens: 1000,
      countTokens: fakeCount,
    });
    const items = await source.collect(input("nonexistent"));
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toContain("无相关命中");
  });

  it("检索抛错 → 占位项降级，不阻断对话", async () => {
    const broken = {
      getStatus: () => ({ state: "ready", fileCount: 1, chunkCount: 1 }) as const,
      query: async () => {
        throw new Error("DW_LLM_TIMEOUT: simulated");
      },
    } as unknown as CodebaseIndex;
    const source = codebaseMatchSource({ getIndex: () => broken, topK: 5, budgetTokens: 1000, countTokens: fakeCount });
    const items = await source.collect(input("login"));
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toContain("检索失败");
    expect(items[0]!.label).toContain("DW_LLM_TIMEOUT");
  });
});
