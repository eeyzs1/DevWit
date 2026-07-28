import type { LocalRoutingConfig, RouteDecision } from "@devwit/contracts";

/**
 * 任务复杂度启发式评分与本地小模型路由（迭代 22 / AC31）。
 *
 * 设计原则（诚实性）：
 * - 这是显式可解释的规则评分，不假装智能——每个得分来源都落 reasons 进轨迹，
 *   用户能在活动流与轨迹面板审计「这次为什么路由到本地/云端」；
 * - 评分只依赖请求发起前的确定信号（意图文本、附件数、是否编排模式），
 *   不看模型输出、不做隐藏分类器；
 * - 路由永不改变任务语义：只是选择 provider，上下文/工具/授权链完全一致。
 */

/** 复杂任务关键词：命中一个 +COMPLEX_KEYWORD_POINTS（封顶 COMPLEX_KEYWORD_CAP）。 */
const COMPLEX_KEYWORDS: readonly { pattern: RegExp; key: string }[] = [
  { pattern: /重构|重新设计|架构/, key: "refactor" },
  { pattern: /迁移|升级.*(?:框架|依赖|版本)/, key: "migrate" },
  { pattern: /整个项目|所有文件|全量|批量/, key: "whole_scope" },
  { pattern: /refactor|redesign|architect/i, key: "en_refactor" },
  { pattern: /migrat|rewrite|overhaul/i, key: "en_migrate" },
];

const LONG_TEXT_CHARS = 200;
const LONG_TEXT_POINTS = 15;
/** 单个复杂信号 +15：两个不同信号（如「重构」+「整个项目」）即达默认阈值 30 判复杂。 */
const COMPLEX_KEYWORD_POINTS = 15;
const COMPLEX_KEYWORD_CAP = 30;
const MANY_ATTACHMENTS = 3;
const ATTACHMENT_POINTS = 10;
const ORCHESTRATE_POINTS = 40;

export interface TaskComplexityInput {
  userText: string;
  attachments?: readonly string[];
  /** 编排模式（planner 分解多步任务）加权——多步骤几乎必然超出小模型能力。 */
  orchestrate?: boolean;
}

export interface TaskComplexity {
  score: number;
  /** 逐项得分来源（ASCII 键：route.reason.*，渲染端 i18n 展示）。 */
  reasons: string[];
}

/** 显式规则评分：score 越高越复杂。零命中 = 0 分（判简单）。 */
export function scoreTaskComplexity(input: TaskComplexityInput): TaskComplexity {
  let score = 0;
  const reasons: string[] = [];
  if (input.orchestrate === true) {
    score += ORCHESTRATE_POINTS;
    reasons.push("orchestrate");
  }
  if (input.userText.length > LONG_TEXT_CHARS) {
    score += LONG_TEXT_POINTS;
    reasons.push("long_text");
  }
  let keywordPoints = 0;
  for (const { pattern, key } of COMPLEX_KEYWORDS) {
    if (keywordPoints >= COMPLEX_KEYWORD_CAP) break;
    if (pattern.test(input.userText)) {
      keywordPoints += COMPLEX_KEYWORD_POINTS;
      reasons.push(`keyword:${key}`);
    }
  }
  score += Math.min(keywordPoints, COMPLEX_KEYWORD_CAP);
  if ((input.attachments?.length ?? 0) >= MANY_ATTACHMENTS) {
    score += ATTACHMENT_POINTS;
    reasons.push("many_attachments");
  }
  return { score, reasons };
}

export interface RouteInput extends TaskComplexityInput {
  /** 模式绑定（或用户显式指定）的 provider id——复杂任务与回退的归宿。 */
  fallbackProviderId: string;
  /** 用户显式指定了模型（会话中切模型 AC5）时跳过路由。 */
  manualOverride?: boolean;
  /** 本地 provider 是否已注册可用（注册表查询结果由调用方给）。 */
  localAvailable: boolean;
}

/** 路由决策：开关/可用性/手动覆盖优先于评分；评分只分「简单→本地 / 复杂→绑定」。 */
export function decideRoute(config: LocalRoutingConfig, input: RouteInput): RouteDecision {
  const { score, reasons } = scoreTaskComplexity(input);
  const base = { score, threshold: config.threshold, reasons };
  if (input.manualOverride === true) {
    return { ...base, routed: "manual", providerId: input.fallbackProviderId };
  }
  if (!config.enabled) {
    return { ...base, routed: "disabled", providerId: input.fallbackProviderId };
  }
  if (config.providerId === "" || !input.localAvailable) {
    return { ...base, routed: "unavailable", providerId: input.fallbackProviderId };
  }
  if (score >= config.threshold) {
    return { ...base, routed: "complex", providerId: input.fallbackProviderId };
  }
  return { ...base, routed: "local", providerId: config.providerId };
}

/** settings 反序列化：非法/缺省回退（默认关、阈值 30）。 */
export const DEFAULT_ROUTING: LocalRoutingConfig = { enabled: false, providerId: "", threshold: 30 }; // qg-allow: 路由默认复杂度阈值，settings 可覆盖的导出常量

export function parseRoutingConfig(stored: unknown): LocalRoutingConfig {
  if (typeof stored !== "object" || stored === null) return DEFAULT_ROUTING;
  const record = stored as Record<string, unknown>;
  const threshold = record["threshold"];
  return {
    enabled: record["enabled"] === true,
    providerId: typeof record["providerId"] === "string" ? record["providerId"] : "",
    threshold:
      typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1
        ? Math.floor(threshold)
        : DEFAULT_ROUTING.threshold,
  };
}
