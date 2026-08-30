/**
 * AgentBackend seam（Fusion Plan v3 — B-WU6）。
 *
 * 把"谁来驱动 agent 循环"做成可替换接缝（借鉴 DSH 的 agent-loop seam + 呼应
 * claude-agent-sdk / @openai/codex 外部 agent 的接入讨论）：
 *
 * - `AgentBackend` = 接缝定义（Service Definition）：统一的 run 契约。
 * - `InternalAgentBackend` = 默认 Provider：包装自研 AgentLoop（行为与现有一致）。
 * - `BackendRegistry` = 装配点：按 id 解析后端；可选后端 unavailable 时
 *   优雅降级回 internal（fail-closed 方向是"降级到本地"，绝不静默换人）。
 *
 * 外部后端（claude-agent-sdk / @openai/codex）作为 Provider 的接入方式：
 * 实现 AgentBackend，把 SDK 的流式事件映射为 AgentTraceEvent 输出；
 * 二进制/凭据缺失时 available=false，registry 自动回落 internal。
 * 本包不直接依赖这两个 SDK（保持构建全绿；可选依赖由宿主注入）。
 */

import type { AgentTraceEvent, AgentRunInput, ChatMessage } from "@devwit/contracts";
import type { AgentLoop } from "./agent-loop.js";

/** 接缝输入：一次 run 所需的最小上下文（外部后端在此之上自行组提示）。 */
export interface AgentBackendInput {
  sessionId: string;
  userText: string;
  workspaceRoot: string;
  modeId: string;
  /** 可选：本轮之前的会话历史（内部后端注入 transcript；外部后端转成自己的消息）。 */
  priorHistory?: ChatMessage[];
  signal?: AbortSignal;
}

/** 接缝输出：统一结果 + 可审计轨迹事件（映射进 AgentTrace，活动流/持久化不变）。 */
export interface AgentBackendResult {
  finishReason: "completed" | "max_iterations" | "cancelled" | "error";
  finalText: string;
  /** 后端产出的轨迹事件（外部后端须映射；内部后端直接用 loop 的 trace）。 */
  events: AgentTraceEvent[];
  usage?: { inputTokens: number; outputTokens: number };
  errorMessage?: string;
}

/** 接缝定义（Service Definition）：任何 agent 后端都实现此契约。 */
export interface AgentBackend {
  /** 稳定 id："internal" | "claude-agent-sdk" | "codex" | 自定义。 */
  readonly id: string;
  /** 可选后端缺二进制/凭据时为 false——registry 据此优雅降级 internal。 */
  readonly available: boolean;
  run(input: AgentBackendInput): Promise<AgentBackendResult>;
}

/** 默认 Provider：包装自研 AgentLoop，行为与现有 run 完全一致。 */
export class InternalAgentBackend implements AgentBackend {
  readonly id = "internal";
  readonly available = true;

  constructor(private readonly makeLoop: () => AgentLoop) {}

  async run(input: AgentBackendInput): Promise<AgentBackendResult> {
    const loop = this.makeLoop();
    const runInput: AgentRunInput = {
      sessionId: input.sessionId,
      userText: input.userText,
      modeId: input.modeId,
      workspaceRoot: input.workspaceRoot,
    };
    const result = await loop.run(runInput, input.signal, input.priorHistory);
    const trace = loop.trace;
    return {
      finishReason: result.finishReason,
      finalText: result.finalText,
      events: trace ? trace.list() : [],
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    };
  }
}

/** 装配点（Service Provider registry）：按 id 解析后端，unavailable 回落 internal。 */
export class BackendRegistry {
  private readonly backends = new Map<string, AgentBackend>();

  register(backend: AgentBackend): () => void {
    if (this.backends.has(backend.id)) {
      throw new Error(`duplicate agent backend: ${backend.id}`);
    }
    this.backends.set(backend.id, backend);
    return () => {
      this.backends.delete(backend.id);
    };
  }

  /** 解析后端：优先配置的 id；不存在或 unavailable → internal（优雅降级）。 */
  resolve(configuredId: string, fallback: AgentBackend): AgentBackend {
    if (configuredId === "internal") return fallback;
    const backend = this.backends.get(configuredId);
    if (backend === undefined || !backend.available) {
      // 可选后端缺失：降级 internal，绝不静默失败
      return fallback;
    }
    return backend;
  }

  list(): string[] {
    return [...this.backends.keys()];
  }
}
