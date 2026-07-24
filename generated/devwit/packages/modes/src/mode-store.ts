import type { ContextItemType, ModeDefinition } from "@devwit/contracts";
import { DEFAULT_CONTEXT_POLICY } from "@devwit/context-engine";

/**
 * 内置模式的固定创建时间（确定性常量，便于审计与测试）。
 */
const BUILTIN_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** 内置 chat 模式：纯对话，零工具，上下文全默认极简（AR007）。 */
export const BUILTIN_CHAT_MODE: ModeDefinition = {
  id: "chat",
  name: "Chat",
  description: "纯对话：极简上下文，无工具",
  systemPrompt:
    "你是 DevWit，一个简洁的 AI 编程助手。直接回答用户问题，不堆砌无关信息。" +
    "此模式没有工具；如需查看文件或执行命令，请用户把内容贴进对话。",
  tools: [],
  providerId: "",
  contextPolicy: {},
  builtin: true,
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

/** 内置 agent 模式：全量内置工具，写/改/执行经授权门（AC4）。 */
export const BUILTIN_AGENT_MODE: ModeDefinition = {
  id: "agent",
  name: "Agent",
  description: "多步任务：读写文件与执行命令需用户授权",
  systemPrompt:
    "你是 DevWit 的编码 Agent，通过工具逐步完成用户任务。" +
    "先用 read/grep/find/ls 了解现状，再用 write/edit 做最小修改，必要时用 bash 验证。" +
    "修改文件前先读文件；一次只推进一小步；完成后用一句话说明做了什么。",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  providerId: "",
  contextPolicy: {},
  builtin: true,
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

/** 内置 orchestrator 模式（AC20）：Planner 分解 + 并行子 Agent + 授权门继承 + 综合。 */
export const BUILTIN_ORCHESTRATOR_MODE: ModeDefinition = {
  id: "orchestrator",
  name: "Orchestrator",
  description: "多 Agent 编排：意图分解为子任务，并行子 Agent 执行后综合结论",
  systemPrompt:
    "你是 DevWit 的编排协调者。你的任务由编排器分解后交给并行子 Agent 执行，" +
    "你负责理解用户原始意图，并在收到各子任务结论后给出准确、完整的最终综合答复。",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  providerId: "",
  contextPolicy: {},
  orchestrate: true,
  builtin: true,
  createdAt: BUILTIN_TIMESTAMP,
  updatedAt: BUILTIN_TIMESTAMP,
};

export const BUILTIN_MODES: readonly ModeDefinition[] = [BUILTIN_CHAT_MODE, BUILTIN_AGENT_MODE, BUILTIN_ORCHESTRATOR_MODE];

const VALID_CONTEXT_TYPES: ReadonlySet<string> = new Set<string>(Object.keys(DEFAULT_CONTEXT_POLICY));

/** 模式的完整上下文策略 = 引擎默认 ← 模式覆盖（供 UI 展示与引擎默认值对齐）。 */
export function resolveModeContextPolicy(mode: ModeDefinition): Record<ContextItemType, boolean> {
  return { ...DEFAULT_CONTEXT_POLICY, ...mode.contextPolicy };
}

export function validateModeDefinition(mode: ModeDefinition): void {
  // 校验消息保持 ASCII：这些错误会经 IPC 抛到主进程 stderr（GBK 终端防乱码）
  if (!mode || typeof mode !== "object") throw new Error("ModeDefinition must be an object");
  if (typeof mode.id !== "string" || mode.id.trim() === "") throw new Error("mode id must not be empty");
  if (typeof mode.name !== "string" || mode.name.trim() === "") throw new Error("mode name must not be empty");
  if (typeof mode.description !== "string") throw new Error("mode description must be a string");
  if (typeof mode.systemPrompt !== "string") throw new Error("mode systemPrompt must be a string");
  if (!Array.isArray(mode.tools) || mode.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw new Error("mode tools must be an array of non-empty strings");
  }
  if (typeof mode.providerId !== "string") throw new Error("mode providerId must be a string (empty = unbound)");
  if (!mode.contextPolicy || typeof mode.contextPolicy !== "object" || Array.isArray(mode.contextPolicy)) {
    throw new Error("mode contextPolicy must be an object");
  }
  for (const [key, value] of Object.entries(mode.contextPolicy)) {
    if (!VALID_CONTEXT_TYPES.has(key)) throw new Error(`mode contextPolicy has unknown context type: ${key}`);
    if (typeof value !== "boolean") throw new Error(`mode contextPolicy.${key} must be a boolean`);
  }
  if (typeof mode.builtin !== "boolean") throw new Error("mode builtin must be a boolean");
  if (mode.orchestrate !== undefined && typeof mode.orchestrate !== "boolean") {
    throw new Error("mode orchestrate must be a boolean when present");
  }
  if (Number.isNaN(Date.parse(mode.createdAt))) throw new Error("mode createdAt must be a parseable date string");
  if (Number.isNaN(Date.parse(mode.updatedAt))) throw new Error("mode updatedAt must be a parseable date string");
}

/** 深拷贝模式（tools 数组与 contextPolicy 对象均隔离，外部改动不影响 store）。 */
function cloneMode(mode: ModeDefinition): ModeDefinition {
  return { ...mode, tools: [...mode.tools], contextPolicy: { ...mode.contextPolicy } };
}

/**
 * ModeStore：模式定义的内存注册表（schema/CRUD/热更新）。
 * - 构造时种入内置 chat/agent 模式；内置模式不可删除（可编辑，builtin 标志保留）；
 * - upsert/delete/replaceAll 触发 onDidChange——watcher 热生效，
 *   agent-runtime 每次请求读取当前模式，下次请求即用新模式（AC6）；
 * - providerId 允许空串：表示未绑定 provider，由运行时回落到当前选中的 provider。
 */
export class ModeStore {
  private readonly modes = new Map<string, ModeDefinition>();
  private readonly listeners = new Set<() => void>();

  constructor(seedBuiltin = true) {
    if (seedBuiltin) {
      for (const mode of BUILTIN_MODES) this.modes.set(mode.id, cloneMode(mode));
    }
  }

  list(): ModeDefinition[] {
    return [...this.modes.values()].map(cloneMode);
  }

  get(id: string): ModeDefinition | undefined {
    const mode = this.modes.get(id);
    return mode ? cloneMode(mode) : undefined;
  }

  /** 新建或更新模式。createdAt 沿用已有值（新建取输入值），updatedAt 刷新为当前时间。 */
  upsert(mode: ModeDefinition): void {
    validateModeDefinition(mode);
    const existing = this.modes.get(mode.id);
    const now = new Date().toISOString();
    this.modes.set(mode.id, {
      ...cloneMode(mode),
      builtin: existing?.builtin ?? mode.builtin,
      createdAt: existing?.createdAt ?? mode.createdAt,
      updatedAt: now,
    });
    this.emitChange();
  }

  /** 删除用户模式。内置模式不可删除（抛错）；id 不存在返回 false。 */
  delete(id: string): boolean {
    const existing = this.modes.get(id);
    if (!existing) return false;
    if (existing.builtin) throw new Error(`builtin mode cannot be deleted: ${id}`);
    this.modes.delete(id);
    this.emitChange();
    return true;
  }

  /**
   * 批量水合（如 apps 层从 modes.json 加载）：整体校验通过后，
   * 清空用户模式并装入给定列表；内置 id 冲突时保留 builtin=true。只触发一次变更事件。
   */
  replaceAll(modes: ModeDefinition[]): void {
    for (const mode of modes) validateModeDefinition(mode);
    for (const [id, mode] of this.modes) {
      if (!mode.builtin) this.modes.delete(id);
    }
    for (const mode of modes) {
      const builtin = this.modes.get(mode.id)?.builtin ?? mode.builtin;
      this.modes.set(mode.id, { ...cloneMode(mode), builtin });
    }
    this.emitChange();
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
