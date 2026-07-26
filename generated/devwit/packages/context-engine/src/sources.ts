import { randomUUID } from "node:crypto";
import type { ChatMessage, ContextItem, ContextItemType, ContextSource, DiagnosticEntry, ResolvedSymbol } from "@devwit/contracts";

/**
 * 内置上下文源工厂。
 *
 * 设计原则（AR007 与包边界）：context-engine 不直接碰 fs/git/terminal——
 * 文件内容由调用方注入 reader，git 状态注入 getStatus 函数，终端尾段经
 * ContextCollectInput.terminalTail 或注入 provider 传入。
 *
 * 源产出的 ContextItem 只填 id/type/label/content/source；enabled/tokens/counting
 * 由 ContextEngine.buildManifest 按策略统一重算（源里写的是占位值）。
 */

/** 构造一个"原始"上下文项（enabled/tokens/counting 为占位值，由引擎覆盖）。 */
export function makeRawItem(type: ContextItemType, label: string, content: string, source?: string): ContextItem {
  return {
    id: `item-${randomUUID()}`,
    type,
    label,
    enabled: true,
    tokens: 0,
    content,
    ...(source !== undefined ? { source } : {}),
    counting: "exact",
  };
}

/** 把会话历史序列化为可审计文本（用于 manifest 展示与 token 计数）。 */
export function serializeConversationHistory(history: ChatMessage[]): string {
  return history.map((message) => `[${message.role}] ${message.content}`).join("\n");
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** 编辑器当前选区。无选区时不产生项。 */
export function selectionSource(): ContextSource {
  return {
    type: "selection",
    async collect(input) {
      const selection = input.selection;
      if (!selection || selection.text.length === 0) return [];
      return [
        makeRawItem(
          "selection",
          `选区 L${selection.startLine}-L${selection.endLine}`,
          selection.text,
          input.activeFile ?? "selection"
        ),
      ];
    },
  };
}

/**
 * 活动文件片段。文件内容由调用方注入的 readFile 提供（全文或片段由注入方决定），
 * 保持 context-engine 不直接依赖 fs。
 */
export function fileFragmentSource(readFile: (path: string) => Promise<string>): ContextSource {
  return {
    type: "file_fragment",
    async collect(input) {
      if (!input.activeFile) return [];
      const content = await readFile(input.activeFile);
      return [makeRawItem("file_fragment", `文件片段 ${basename(input.activeFile)}`, content, input.activeFile)];
    },
  };
}

/**
 * @文件引用（迭代 19 / AC28）：用户在输入框显式提及的工作区文件。
 * 每个引用 = 独立 file_fragment 项，key=attachment:<路径> 稳定（跨 build 可逐项剔除，
 * 与 RAG chunk 同机制）；单文件读取失败（选择后被删/移动的竞态）跳过该附件不阻断整轮。
 */
export function attachmentSource(readFile: (path: string) => Promise<string>): ContextSource {
  return {
    type: "file_fragment",
    async collect(input) {
      const attachments = input.attachments;
      if (attachments === undefined || attachments.length === 0) return [];
      const items: ContextItem[] = [];
      for (const attachmentPath of attachments) {
        try {
          const content = await readFile(attachmentPath);
          items.push({
            ...makeRawItem("file_fragment", `引用文件 ${attachmentPath}`, content, "attachment"),
            key: `attachment:${attachmentPath}`,
          });
        } catch {
          // 渲染端只提供树内存在文件，此处仅兜底罕见竞态——静默跳过，manifest 中自然缺席
        }
      }
      return items;
    },
  };
}

/**
 * @符号 引用（迭代 29 / AC38）：用户在输入框显式提及的代码符号。
 * 每个引用 = 独立 file_fragment 项，key=symbol:<id> 稳定（可逐项剔除，与附件同机制）。
 * resolve 由主进程 SymbolIndex 注入（重读文件切片，内容为事实源）；
 * 符号消失（编辑后行号漂移/文件删除）返回 null → 静默跳过不阻断整轮。
 */
export function symbolRefSource(resolve: (symbolId: string) => Promise<ResolvedSymbol | null>): ContextSource {
  return {
    type: "file_fragment",
    async collect(input) {
      const refs = input.symbolRefs;
      if (refs === undefined || refs.length === 0) return [];
      const items: ContextItem[] = [];
      for (const ref of refs) {
        try {
          const resolved = await resolve(ref);
          if (resolved === null) continue;
          items.push({
            ...makeRawItem(
              "file_fragment",
              `引用符号 ${resolved.name}（${resolved.relPath} L${resolved.startLine}-${resolved.endLine}）`,
              resolved.text,
              "symbol"
            ),
            key: `symbol:${ref}`,
          });
        } catch {
          // 与附件源同策略：单符号失败不拖垮整轮注入
        }
      }
      return items;
    },
  };
}

/** git 状态（如 `git status --short` 输出）。getStatus 由 workspace 层注入。 */
export function gitStatusSource(getStatus: (workspaceRoot: string) => Promise<string>): ContextSource {
  return {
    type: "git_status",
    async collect(input) {
      if (!input.workspaceRoot) return [];
      const content = await getStatus(input.workspaceRoot);
      return [makeRawItem("git_status", "Git 状态", content, "git status")];
    },
  };
}

/**
 * 终端尾段输出。优先取 ContextCollectInput.terminalTail（每次请求由调用方刷新），
 * 否则回退到注入的 tailProvider。
 */
export function terminalTailSource(tailProvider?: () => string | Promise<string>): ContextSource {
  return {
    type: "terminal_output",
    async collect(input) {
      const tail = input.terminalTail ?? (tailProvider ? await tailProvider() : undefined);
      if (tail === undefined) return [];
      return [makeRawItem("terminal_output", "终端输出", tail, "terminal")];
    },
  };
}

/**
 * 诊断回馈（迭代 21 / AC30）：agent 编辑文件后的最新 tsc 诊断快照。
 * 快照由调用方（DiagnosticsTracker）在 write/edit 工具成功后刷新，本源只读——
 * 零问题时产出零项（没有要修复的内容就不占 token），问题出现时下一轮请求自动携带。
 */
export function diagnosticsSource(getEntries: () => readonly DiagnosticEntry[]): ContextSource {
  return {
    type: "diagnostics",
    async collect() {
      const entries = getEntries();
      if (entries.length === 0) return [];
      const content = entries
        .map((entry) => `${entry.file}:${entry.line}:${entry.column} ${entry.severity} ${entry.code ?? ""} ${entry.message}`.trim())
        .join("\n");
      return [
        {
          ...makeRawItem("diagnostics", `诊断（${entries.length} 个问题）`, content, "tsc --noEmit"),
          key: "diagnostics:latest",
        },
      ];
    },
  };
}

/**
 * 工作流记忆（AC32）：新任务命中已沉淀的成功工作流模板时，产出一条建议性
 * workflow 项（工具序列参考）。未命中/未启用时不产项（零占位 token）；
 * 用户可经 workflow 类型闸或逐项开关剔除（AC2 可控性语义不变）。
 */
export function workflowSource(
  getMatch: () => { intent: string; modeId: string; tools: readonly string[]; reuseCount: number } | null
): ContextSource {
  return {
    type: "workflow",
    async collect() {
      const match = getMatch();
      if (match === null) return [];
      const content = [
        "相似任务此前已成功完成，可参考其工作流（建议，非指令）：",
        `意图：${match.intent}`,
        `成功工具序列：${match.tools.join(" → ")}`,
      ].join("\n");
      return [
        {
          ...makeRawItem("workflow", `复用工作流（${match.tools.join(" → ")}）`, content, "workflow-memory"),
          key: "workflow:reuse",
        },
      ];
    },
  };
}

/** 会话历史（可审计序列化形式；实际注入由引擎以原始 ChatMessage[] 完成）。 */
export function conversationHistorySource(): ContextSource {
  return {
    type: "conversation_history",
    async collect(input) {
      if (input.conversationHistory.length === 0) return [];
      return [
        makeRawItem(
          "conversation_history",
          `会话历史（${input.conversationHistory.length} 条）`,
          serializeConversationHistory(input.conversationHistory),
          "conversation"
        ),
      ];
    },
  };
}
