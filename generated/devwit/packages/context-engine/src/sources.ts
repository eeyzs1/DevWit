import { randomUUID } from "node:crypto";
import type { ChatMessage, ContextItem, ContextItemType, ContextSource } from "@devwit/contracts";

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
