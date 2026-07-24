import type { ContextItem, ContextSource } from "@devwit/contracts";
import { makeRawItem } from "@devwit/context-engine";
import type { CodebaseIndex } from "./codebase-index.js";

/**
 * codebase_match 上下文源（迭代 10 / AC19）：透明 RAG 与 context-engine 的桥。
 *
 * 透明度设计（AC2 语义在检索层的延伸）：
 * - 每个命中块 = 一个独立 ContextItem（带稳定 key=chunkId、score、路径行区间），
 *   在上下文面板可逐项剔除（setItemOverride），manifest 落盘可审计；
 * - 索引不可用时产出"占位项"（说明原因：构建中/错误/未启用），可见性不依赖
 *   可用性——用户始终知道"为什么这次没有代码库上下文"；
 * - 检索失败（embedding 网络错误等）不 throw，降级为占位项，绝不阻断对话。
 */

export interface CodebaseMatchSourceDeps {
  /** 取当前索引实例；未启用/未初始化时返回 null。 */
  getIndex(): CodebaseIndex | null;
  topK: number;
  budgetTokens: number;
  countTokens: (text: string) => number;
}

export function codebaseMatchSource(deps: CodebaseMatchSourceDeps): ContextSource {
  return {
    type: "codebase_match",
    async collect(input): Promise<ContextItem[]> {
      const query = input.query;
      if (query === undefined || query.trim() === "") return [];
      const index = deps.getIndex();
      if (index === null) {
        return [placeholder("代码库检索（索引未启用）")];
      }
      const status = index.getStatus();
      if (status.state === "indexing") {
        return [placeholder(`代码库检索（索引构建中 ${status.indexedFiles}/${status.totalFiles}）`)];
      }
      if (status.state === "error") {
        return [placeholder(`代码库检索（索引不可用: ${status.code}）`)];
      }
      if (status.state !== "ready") {
        return [placeholder("代码库检索（索引未就绪）")];
      }
      try {
        const hits = await index.query(query, {
          topK: deps.topK,
          budgetTokens: deps.budgetTokens,
          countTokens: deps.countTokens,
        });
        if (hits.length === 0) {
          return [placeholder("代码库检索（无相关命中）")];
        }
        return hits.map((hit) => ({
          ...makeRawItem(
            "codebase_match",
            `${hit.relPath} L${hit.startLine}-${hit.endLine} · ${hit.score.toFixed(3)}`,
            hit.text,
            hit.relPath
          ),
          key: hit.id,
          score: hit.score,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.startsWith("DW_") ? message : "DW_RAG_QUERY_FAILED";
        return [placeholder(`代码库检索（检索失败: ${code}）`)];
      }
    },
  };
}

/** 占位项：说明"本次为何没有代码库上下文"（无 key，仅受类型开关控制）。 */
function placeholder(label: string): ContextItem {
  return makeRawItem("codebase_match", label, "", "rag");
}
