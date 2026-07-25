import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ContextItem,
  ContextItemType,
  ContextManifest,
  ContextSource,
  ToolDefinition,
} from "@devwit/contracts";
import { makeRawItem, serializeConversationHistory } from "./sources.js";
import { TiktokenCounter, type TokenCounter } from "./token-counter.js";

/**
 * 引擎默认上下文策略（AR007 默认极简）：仅系统提示 + 工具定义开启，
 * 其余类型默认关闭——未开启的项零注入（不进 messages/tools），
 * 但在 manifest 中保留可见条目（content 置空、tokens=0）。
 */
export const DEFAULT_CONTEXT_POLICY: Readonly<Record<ContextItemType, boolean>> = {
  system_prompt: true,
  tool_definitions: true,
  file_fragment: false,
  git_status: false,
  terminal_output: false,
  selection: false,
  conversation_history: false,
  // 默认关闭：需先在设置中启用代码索引（AC19），启用时由 AiRuntime 自动打开本类型开关
  codebase_match: false,
  // 默认关闭：仅 agent 类模式经模式策略打开（AC30：编辑后 tsc 诊断回馈下一轮上下文）
  diagnostics: false,
  custom: false,
};

const ALL_CONTEXT_TYPES = Object.keys(DEFAULT_CONTEXT_POLICY) as ContextItemType[];

/**
 * 注入到用户上下文消息中的类型（按此顺序拼接为一段 user 消息）。
 * system_prompt 走 system 消息、tool_definitions 走 tools 参数、
 * conversation_history 展开为原始消息序列，均不在此列。
 */
const INJECTED_AS_USER_CONTEXT: readonly ContextItemType[] = [
  "selection",
  "file_fragment",
  "codebase_match",
  "git_status",
  "terminal_output",
  "diagnostics",
  "custom",
];

/** manifest 落盘端口：由 apps 层实现（写 evidence/AC2 等），引擎自身不碰 fs。 */
export interface ManifestStore {
  save(manifest: ContextManifest): void | Promise<void>;
}

export interface ContextEngineOptions {
  sessionId: string;
  /** token 计数器：OpenAI 系传 TiktokenCounter（exact），Anthropic 系传 EstimatedCounter。 */
  counter?: TokenCounter;
  /** 每次 build 后回调落盘 manifest（AC2 审计要求：每次请求一份）。 */
  manifestStore?: ManifestStore;
}

export interface ContextBuildInput {
  modeId: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  /** 当前模式的上下文策略（ModeDefinition.contextPolicy），覆盖引擎默认值。 */
  contextPolicy?: Partial<Record<ContextItemType, boolean>>;
  workspaceRoot?: string;
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  terminalTail?: string;
  conversationHistory: ChatMessage[];
  /** 本轮用户意图原文（AC19：透传给 codebase_match 检索源）。 */
  query?: string;
}

/** 一次上下文构建的完整产物：可审计 manifest + 实际发往 provider 的 messages/tools。 */
export interface ContextBuild {
  manifest: ContextManifest;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

/** 三类开关的优先级：用户逐项开关 > 模式策略 > 引擎默认（AR007）。 */
export function resolveItemEnabled(
  type: ContextItemType,
  userOverrides: ReadonlyMap<ContextItemType, boolean>,
  modePolicy?: Partial<Record<ContextItemType, boolean>>
): boolean {
  const userOverride = userOverrides.get(type);
  if (userOverride !== undefined) return userOverride;
  const modeValue = modePolicy?.[type];
  if (modeValue !== undefined) return modeValue;
  return DEFAULT_CONTEXT_POLICY[type];
}

/** 把开启的注入类上下文项拼成一段用户消息（零开启项时返回 null——零注入）。 */
export function composeUserContextMessage(items: ContextItem[]): string | null {
  const enabled = items.filter(
    (item) => item.enabled && INJECTED_AS_USER_CONTEXT.includes(item.type) && item.content.length > 0
  );
  if (enabled.length === 0) return null;
  return enabled.map((item) => `## ${item.label}\n${item.content}`).join("\n\n");
}

/**
 * ContextEngine：简洁上下文引擎。
 * - 源注册表：registerSource 注册模块化上下文源（文件片段/git 状态/终端输出等）；
 * - 逐项开关：setTypeEnabled 按类型开关（内置源每类型至多一项，与 UI 逐项开关一一对应）；
 * - 每次 build 产出 ContextManifest（含各项 token 计数）并经 ManifestStore 落盘；
 * - 未开启项零注入：不进 messages/tools，manifest 中 content 置空、tokens=0。
 */
export class ContextEngine {
  private readonly sessionId: string;
  private readonly counter: TokenCounter;
  private readonly manifestStore?: ManifestStore;
  private readonly sources: ContextSource[] = [];
  private readonly userOverrides = new Map<ContextItemType, boolean>();
  /** 稳定 key 项的逐项开关（AC19）：优先级高于类型级开关，仅对带 key 的项生效。 */
  private readonly itemOverrides = new Map<string, boolean>();
  private latestManifest: ContextManifest | null = null;

  constructor(options: ContextEngineOptions) {
    this.sessionId = options.sessionId;
    this.counter = options.counter ?? new TiktokenCounter();
    if (options.manifestStore !== undefined) this.manifestStore = options.manifestStore;
  }

  /** 注册上下文源，返回注销函数。 */
  registerSource(source: ContextSource): () => void {
    this.sources.push(source);
    return () => {
      const index = this.sources.indexOf(source);
      if (index >= 0) this.sources.splice(index, 1);
    };
  }

  /** 逐项（按类型）开关。优先级高于模式策略与引擎默认（显式设为默认值也算覆盖）。 */
  setTypeEnabled(type: ContextItemType, enabled: boolean): void {
    this.userOverrides.set(type, enabled);
  }

  /** 清除某项的用户开关，回落到 模式策略 → 引擎默认。 */
  clearTypeOverride(type: ContextItemType): void {
    this.userOverrides.delete(type);
  }

  /**
   * 稳定 key 项的逐项开关（AC19 codebase_match 单块剔除/恢复）。
   * 生效条件：项带 key 且其类型级解析结果为开启——类型关闭时全部零注入，
   * item override 无法复活（类型是总闸，保持 AC2 的"一键全关"语义）。
   */
  setItemOverride(key: string, enabled: boolean): void {
    this.itemOverrides.set(key, enabled);
  }

  clearItemOverride(key: string): void {
    this.itemOverrides.delete(key);
  }

  /** 当前生效的完整策略视图（默认 ← 模式策略 ← 用户开关），供 UI 面板渲染。 */
  getPolicyView(modePolicy?: Partial<Record<ContextItemType, boolean>>): Record<ContextItemType, boolean> {
    const view = {} as Record<ContextItemType, boolean>;
    for (const type of ALL_CONTEXT_TYPES) {
      view[type] = resolveItemEnabled(type, this.userOverrides, modePolicy);
    }
    return view;
  }

  getLatestManifest(): ContextManifest | null {
    return this.latestManifest;
  }

  /**
   * 构建一次请求的上下文：收集所有源 → 按策略解析开关 → 计数 → 组消息。
   * 产出 manifest 并落盘（每次请求一份，AC2/AR007）。
   */
  async build(input: ContextBuildInput): Promise<ContextBuild> {
    const rawItems: ContextItem[] = [
      makeRawItem("system_prompt", "系统提示", input.systemPrompt, "mode"),
      makeRawItem("tool_definitions", `工具定义（${input.tools.length} 个）`, serializeToolDefinitions(input.tools), "mode"),
      // 会话历史项恒定存在：composeMessages 依据其 enabled 决定是否注入原始消息，
      // 且"历史开关"必须在 manifest/UI 中始终可见（AC2），与是否注册外部源无关。
      makeRawItem(
        "conversation_history",
        `会话历史（${input.conversationHistory.length} 条）`,
        serializeConversationHistory(input.conversationHistory),
        "conversation"
      ),
    ];
    for (const source of this.sources) {
      const collected = await source.collect(input);
      rawItems.push(...collected);
    }

    const counting: ContextItem["counting"] = this.counter.exact ? "exact" : "estimated";
    const items: ContextItem[] = rawItems.map((item) => {
      const typeEnabled = resolveItemEnabled(item.type, this.userOverrides, input.contextPolicy);
      // 类型是总闸：类型关闭 → 恒不注入；类型开启时带 key 项可被逐项剔除（AC19）
      const itemOverride = item.key !== undefined ? this.itemOverrides.get(item.key) : undefined;
      const enabled = typeEnabled && (itemOverride ?? true);
      return {
        ...item,
        enabled,
        tokens: enabled ? this.counter.count(item.content) : 0,
        content: enabled ? item.content : "",
        counting,
      };
    });

    const manifest: ContextManifest = {
      id: `manifest-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      modeId: input.modeId,
      providerId: input.providerId,
      model: input.model,
      items,
      totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      systemPromptTokens: items
        .filter((item) => item.type === "system_prompt" && item.enabled)
        .reduce((sum, item) => sum + item.tokens, 0),
    };

    if (this.manifestStore) await this.manifestStore.save(manifest);
    this.latestManifest = manifest;

    return {
      manifest,
      messages: composeMessages(items, input.conversationHistory),
      tools: isEnabled(items, "tool_definitions") ? input.tools : [],
    };
  }
}

function isEnabled(items: ContextItem[], type: ContextItemType): boolean {
  return items.some((item) => item.type === type && item.enabled);
}

/** 由解析后的上下文项组装发往 provider 的消息序列（未开启项零注入）。 */
export function composeMessages(items: ContextItem[], conversationHistory: ChatMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const systemItem = items.find((item) => item.type === "system_prompt" && item.enabled);
  if (systemItem && systemItem.content.length > 0) {
    messages.push({ role: "system", content: systemItem.content });
  }
  const userContext = composeUserContextMessage(items);
  if (userContext !== null) {
    messages.push({ role: "user", content: userContext });
  }
  if (isEnabled(items, "conversation_history")) {
    messages.push(...conversationHistory);
  }
  return messages;
}

function serializeToolDefinitions(tools: ToolDefinition[]): string {
  return JSON.stringify(
    tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    null,
    2
  );
}
