import type { AgentTraceEvent, WorkflowTemplate } from "@devwit/contracts";

/**
 * 工作流记忆（迭代 23 / AC32，DI-I021）：成功任务轨迹沉淀为可复用工作流模板。
 *
 * 设计原则（诚实性）：
 * - 只从「真实成功」的 run 学习：本轮事件含 done、无 error、至少一次工具调用
 *   （纯对话无工作流可沉淀；失败/中断的经验不传播）；
 * - 复用是建议不是自动执行：命中模板仅作为 custom 上下文项注入（工具序列参考），
 *   模型仍自主规划，授权门语义完全不变；
 * - 匹配规则显式可解释：关键词重叠数 >= 2 判相似，命中关键词落轨迹可审计，
 *   不做隐藏语义分类器；
 * - 用户可整体停用、逐条删除或清空（settings 直读直写，热生效）。
 */

/** 模板上限：超出时逐出最久未刷新的（复用次数多的新鲜模板自然留存）。 */
export const MAX_WORKFLOW_TEMPLATES = 50;
/** 相似判定：共享关键词数下限。 */
export const MIN_SHARED_KEYWORDS = 2;
/** 单条意图提取的关键词上限（防长文噪声淹没匹配）。 */
const MAX_KEYWORDS = 24;

/**
 * 关键词提取（确定性、可解释）：
 * - 拉丁词：含文件名点号/连字符（login.ts、use-state），小写归一；
 * - 中文：<=4 字 run 整取 + 全部 2-gram 滑窗（「输入校验」→ 输入/入校/校验/输入校验）。
 */
export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_.-]{1,}/g)) {
    keywords.add(match[0]);
  }
  for (const match of text.matchAll(/[一-鿿]{2,}/g)) {
    const run = match[0];
    if (run.length <= 4) keywords.add(run);
    for (let i = 0; i + 2 <= run.length; i += 1) {
      keywords.add(run.slice(i, i + 2));
    }
  }
  return [...keywords].slice(0, MAX_KEYWORDS);
}

/** 存储适配：由 apps 层桥到 settings（读快照 / 原子写回），与命令白名单同模式。 */
export interface WorkflowMemoryStore {
  read(): WorkflowTemplate[];
  write(templates: WorkflowTemplate[]): void;
}

export interface WorkflowMatch {
  template: WorkflowTemplate;
  /** 命中的共享关键词（升序；审计可见）。 */
  shared: string[];
}

/** settings 反序列化：非数组/缺字段条目丢弃（诚实降级为空记忆）。 */
export function parseWorkflowTemplates(stored: unknown): WorkflowTemplate[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (item): item is WorkflowTemplate =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { intent?: unknown }).intent === "string" &&
      typeof (item as { modeId?: unknown }).modeId === "string" &&
      Array.isArray((item as { tools?: unknown }).tools) &&
      typeof (item as { learnedAt?: unknown }).learnedAt === "string" &&
      typeof (item as { reuseCount?: unknown }).reuseCount === "number"
  );
}

let nextSeq = 1;

export class WorkflowMemory {
  constructor(private readonly store: WorkflowMemoryStore) {}

  list(): WorkflowTemplate[] {
    return this.store.read();
  }

  /**
   * 从一轮 run 的轨迹事件学习（仅成功且含工具调用的 run 够格）。
   * 同意图再学刷新原模板（保 id 与 reuseCount）；返回学到/刷新的模板，不够格返回 null。
   */
  learnFromRun(events: readonly AgentTraceEvent[], modeId: string, now: Date = new Date()): WorkflowTemplate | null {
    const hasDone = events.some((event) => event.type === "done");
    const hasError = events.some((event) => event.type === "error");
    if (!hasDone || hasError) return null;
    const intentEvent = events.find((event) => event.type === "user_message");
    const intentText = (intentEvent?.detail as { text?: unknown } | undefined)?.text;
    const intent = typeof intentText === "string" ? intentText.trim() : "";
    if (intent === "") return null;
    const tools: string[] = [];
    for (const event of events) {
      if (event.type !== "tool_call") continue;
      const tool = (event.detail as { tool?: unknown } | undefined)?.tool;
      if (typeof tool === "string" && tool !== "" && !tools.includes(tool)) tools.push(tool);
    }
    if (tools.length === 0) return null;

    const templates = [...this.store.read()];
    const existing = templates.find((template) => template.intent.trim() === intent);
    if (existing !== undefined) {
      existing.tools = tools;
      existing.modeId = modeId;
      existing.learnedAt = now.toISOString();
      this.store.write(templates);
      return existing;
    }
    const template: WorkflowTemplate = {
      id: `wf-${now.getTime().toString(36)}-${nextSeq}`,
      intent,
      modeId,
      tools,
      learnedAt: now.toISOString(),
      reuseCount: 0,
    };
    nextSeq += 1;
    templates.push(template);
    while (templates.length > MAX_WORKFLOW_TEMPLATES) {
      let oldest = 0;
      for (let i = 1; i < templates.length; i += 1) {
        if (templates[i]!.learnedAt < templates[oldest]!.learnedAt) oldest = i;
      }
      templates.splice(oldest, 1);
    }
    this.store.write(templates);
    return template;
  }

  /** 相似匹配：共享关键词 >= MIN_SHARED_KEYWORDS 取最优（共享数降序 → 学习近者优先）。 */
  match(intent: string): WorkflowMatch | null {
    const keywords = new Set(extractKeywords(intent));
    if (keywords.size === 0) return null;
    let best: WorkflowMatch | null = null;
    for (const template of this.store.read()) {
      const shared = extractKeywords(template.intent).filter((keyword) => keywords.has(keyword));
      if (shared.length < MIN_SHARED_KEYWORDS) continue;
      if (
        best === null ||
        shared.length > best.shared.length ||
        (shared.length === best.shared.length && template.learnedAt > best.template.learnedAt)
      ) {
        best = { template, shared };
      }
    }
    return best;
  }

  markReused(id: string, now: Date = new Date()): void {
    const templates = [...this.store.read()];
    const hit = templates.find((template) => template.id === id);
    if (hit === undefined) return;
    hit.reuseCount += 1;
    hit.lastReuseAt = now.toISOString();
    this.store.write(templates);
  }

  remove(id: string): void {
    this.store.write(this.store.read().filter((template) => template.id !== id));
  }

  clear(): void {
    this.store.write([]);
  }
}
