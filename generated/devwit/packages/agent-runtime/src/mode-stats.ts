import type { ModeRunStats } from "@devwit/contracts";

/**
 * 模式自进化统计（迭代 24 / AC33，DI-I020）：按模式记录运行成功率。
 *
 * 设计原则（诚实性）：
 * - 只统计「有效定级」的 run：finishReason=completed 记成功、error 记失败；
 *   cancelled / max_iterations / 异常抛出 不定级不计入——用户主动取消与未竟
 *   任务不毒化成功率（定级发生在 AiRuntime，按 AgentRunResult 而非事件猜测）；
 * - 推荐门槛：定级 run 数 >= MIN_RUNS_FOR_RECOMMEND 才参与推荐，
 *   防单次侥幸（1/1 = 100% 不等于可靠）；
 * - 推荐规则显式可解释：推荐模式成功率 >= 当前模式（当前无数据视为 0），
 *   明细随 mode_recommend 事件落轨迹可审计；
 * - settings 直读直写（与工作流记忆同模式），热生效。
 */

/** 参与推荐的最小定级 run 数。 */
export const MIN_RUNS_FOR_RECOMMEND = 3;

/** 存储适配：由 apps 层桥到 settings（读快照 / 原子写回）。 */
export interface ModeStatsStore {
  read(): ModeRunStats[];
  write(stats: ModeRunStats[]): void;
}

/** settings 反序列化：非数组/缺字段/脏数值条目丢弃。 */
export function parseModeRunStats(stored: unknown): ModeRunStats[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (item): item is ModeRunStats =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { modeId?: unknown }).modeId === "string" &&
      typeof (item as { runs?: unknown }).runs === "number" &&
      typeof (item as { successes?: unknown }).successes === "number" &&
      typeof (item as { lastRunAt?: unknown }).lastRunAt === "string"
  );
}

export class ModeStatsTracker {
  constructor(private readonly store: ModeStatsStore) {}

  list(): ModeRunStats[] {
    return this.store.read();
  }

  /** 定级一次 run：success=true 成功 / false 失败。 */
  recordRun(modeId: string, success: boolean, now: Date = new Date()): ModeRunStats {
    const stats = [...this.store.read()];
    let entry = stats.find((item) => item.modeId === modeId);
    if (entry === undefined) {
      entry = { modeId, runs: 0, successes: 0, lastRunAt: now.toISOString() };
      stats.push(entry);
    }
    entry.runs += 1;
    if (success) entry.successes += 1;
    entry.lastRunAt = now.toISOString();
    this.store.write(stats);
    return entry;
  }

  /** 成功率 0-1；该模式无数据返回 null（与「0% 失败」显式区分）。 */
  successRate(modeId: string): number | null {
    const entry = this.store.read().find((item) => item.modeId === modeId);
    if (entry === undefined || entry.runs === 0) return null;
    return entry.successes / entry.runs;
  }

  /**
   * 是否推荐 candidateMode 替代 currentMode：
   * 候选定级数达标 且 候选成功率 >= 当前成功率（当前无数据视为 0）。
   */
  shouldRecommend(candidateMode: string, currentMode: string): boolean {
    if (candidateMode === currentMode) return false;
    const candidate = this.store.read().find((item) => item.modeId === candidateMode);
    if (candidate === undefined || candidate.runs < MIN_RUNS_FOR_RECOMMEND) return false;
    const candidateRate = candidate.successes / candidate.runs;
    const currentRate = this.successRate(currentMode) ?? 0;
    return candidateRate >= currentRate;
  }
}
