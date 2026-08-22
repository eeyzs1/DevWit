/**
 * 用量统计存储（迭代 26 / AC35）：真实 token 用量的本地账本。
 *
 * - 落盘形态与 traces 同口径：userData/usage.jsonl 逐行追加（append-only），
 *   重启后统计不丢；不进 settings（追加型数据避免配置存储膨胀）；
 * - 聚合在读侧按需扫描（记录体量小：每 run 一行）；坏行容忍跳过（审计账本
 *   宁缺毋滥，不让单行损坏拖垮全部统计）；
 * - clear 只删用量账本，不影响会话轨迹与设置。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { UsageBudgetAlert, UsageDailySummary, UsagePricing, UsageRecord, UsageSummary, UsageTotals } from "@devwit/contracts";

/** 本地时区日期键（YYYY-MM-DD）——today 聚合按用户本地日切分。 */
function localDateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, runs: 0 };
}

function isUsageRecord(raw: unknown): raw is UsageRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r["ts"] === "string" &&
    typeof r["sessionId"] === "string" &&
    typeof r["modeId"] === "string" &&
    typeof r["providerId"] === "string" &&
    typeof r["model"] === "string" &&
    typeof r["inputTokens"] === "number" &&
    typeof r["outputTokens"] === "number" &&
    typeof r["finishReason"] === "string"
  );
}

/** 计算单条记录成本：已定价返回数值，未定价返回 null。 */
function computeCost(record: UsageRecord, pricing?: UsagePricing): number | null {
  if (!pricing) return null;
  const price = pricing[`${record.providerId} ${record.model}`];
  if (
    price === undefined ||
    !Number.isFinite(price.inputPerMillion) || price.inputPerMillion < 0 ||
    !Number.isFinite(price.outputPerMillion) || price.outputPerMillion < 0
  ) {
    return null;
  }
  return (record.inputTokens * price.inputPerMillion + record.outputTokens * price.outputPerMillion) / 1_000_000;
}

/** 把一条记录累进目标组（成本可选）：token/runs 恒计，cost 仅已定价时累加。 */
function accumulate(target: UsageTotals, record: UsageRecord, cost: number | null, hasPricing?: boolean): void {
  target.inputTokens += record.inputTokens;
  target.outputTokens += record.outputTokens;
  target.runs += 1;
  if (cost !== null) {
    target.cost = (target.cost ?? 0) + cost;
  } else if (hasPricing) {
    target.unpricedRuns = (target.unpricedRuns ?? 0) + 1;
  }
}

export class UsageStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 追加一条真实用量记录（原子到行：单行 JSON + \n 一次 write）。 */
  append(record: UsageRecord): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf-8");
  }

  readAll(): UsageRecord[] {
    if (!existsSync(this.file)) return [];
    const out: UsageRecord[] = [];
    for (const line of readFileSync(this.file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isUsageRecord(parsed)) out.push(parsed);
      } catch {
        // 坏行容忍：跳过不抛（审计账本不因单行损坏整体不可用）
      }
    }
    return out;
  }

  /**
   * 聚合视图：今日（本地日）/累计/按模式/按服务商（同名服务商不同型号分行）。
   * AC36：传入 pricing（键 "<providerId> <model>"，元/百万 tokens）时逐记录计算
   * 估算成本——已定价记录累入 cost，未定价记录计入 unpricedRuns（部分覆盖可见，
   * 绝不虚构数字）。非法单价项（非数/负数）按未定价处理。
   */
  summary(now: Date = new Date(), pricing?: UsagePricing): UsageSummary {
    const todayKey = localDateKey(now);
    const total = emptyTotals();
    const today = emptyTotals();
    const byMode = new Map<string, UsageTotals>();
    const byProvider = new Map<string, { providerId: string; model: string } & UsageTotals>();
    const hasPricing = pricing !== undefined;
    for (const record of this.readAll()) {
      const cost = computeCost(record, pricing);
      accumulate(total, record, cost, hasPricing);
      const recordDate = new Date(record.ts);
      if (!Number.isNaN(recordDate.getTime()) && localDateKey(recordDate) === todayKey) {
        accumulate(today, record, cost, hasPricing);
      }
      const modeTotals = byMode.get(record.modeId) ?? emptyTotals();
      accumulate(modeTotals, record, cost, hasPricing);
      byMode.set(record.modeId, modeTotals);
      const providerKey = `${record.providerId} ${record.model}`;
      const providerTotals =
        byProvider.get(providerKey) ?? { providerId: record.providerId, model: record.model, ...emptyTotals() };
      accumulate(providerTotals, record, cost, hasPricing);
      byProvider.set(providerKey, providerTotals);
    }
    return {
      total,
      today,
      byMode: [...byMode.entries()].map(([modeId, totals]) => ({ modeId, ...totals })),
      byProvider: [...byProvider.values()],
    };
  }

  /** 清零：删除账本文件（不存在时为空操作）。 */
  clear(): void {
    rmSync(this.file, { force: true });
  }

  /**
   * 按日/按会话成本汇总：byDate 最近 30 天，bySession 按会话维度。
   * 用于成本趋势分析和项目级成本归因。
   */
  dailySummary(pricing?: UsagePricing): UsageDailySummary {
    const byDateMap = new Map<string, UsageTotals>();
    const bySessionMap = new Map<string, UsageTotals>();
    const records = this.readAll();
    const hasPricing = pricing !== undefined;

    for (const record of records) {
      const cost = computeCost(record, pricing);
      // 按日聚合
      const recordDate = new Date(record.ts);
      if (Number.isNaN(recordDate.getTime())) continue;
      const dateKey = localDateKey(recordDate);
      const dateTotals = byDateMap.get(dateKey) ?? emptyTotals();
      accumulate(dateTotals, record, cost, hasPricing);
      byDateMap.set(dateKey, dateTotals);
      // 按会话聚合
      const sessionTotals = bySessionMap.get(record.sessionId) ?? emptyTotals();
      accumulate(sessionTotals, record, cost, hasPricing);
      bySessionMap.set(record.sessionId, sessionTotals);
    }

    // byDate 按日期排序，最近 30 天
    const byDate = [...byDateMap.entries()]
      .map(([date, totals]) => ({ date, ...totals }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    // bySession 按成本降序（无成本时按 token 降序）
    const bySession = [...bySessionMap.entries()]
      .map(([sessionId, totals]) => ({ sessionId, ...totals }))
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

    return { byDate, bySession };
  }

  /**
   * 成本预警检查：比较当前周期成本与阈值，返回超限状态。
   * period: day=今日, week=最近7天, month=最近30天, total=全部。
   */
  checkBudget(threshold: number, period: "day" | "week" | "month" | "total", now: Date = new Date(), pricing?: UsagePricing): UsageBudgetAlert {
    // 阈值 <= 0 视为「未设置有效上限」：不误报（0 成本也不该 0>=0 判超限）。
    if (!(threshold > 0)) {
      return { threshold, current: 0, exceeded: false, period };
    }
    const records = this.readAll();
    let current = 0;
    const nowMs = now.getTime();

    for (const record of records) {
      const cost = computeCost(record, pricing);
      if (cost === null) continue;
      const recordMs = new Date(record.ts).getTime();
      if (Number.isNaN(recordMs)) continue;

      let inRange = false;
      if (period === "total") {
        inRange = true;
      } else if (period === "day") {
        inRange = localDateKey(new Date(recordMs)) === localDateKey(now);
      } else {
        const days = period === "week" ? 7 : 30;
        inRange = recordMs >= nowMs - days * 24 * 60 * 60 * 1000;
      }
      if (inRange) current += cost;
    }

    return { threshold, current, exceeded: current >= threshold, period };
  }

  /**
   * 导出成本报告为 CSV 字符串。
   * 列：ts, sessionId, modeId, providerId, model, inputTokens, outputTokens, cost, finishReason
   */
  exportCSV(pricing?: UsagePricing): string {
    const records = this.readAll();
    const header = "ts,sessionId,modeId,providerId,model,inputTokens,outputTokens,cost,finishReason";
    const lines = records.map((r) => {
      const cost = computeCost(r, pricing);
      return [r.ts, r.sessionId, r.modeId, r.providerId, r.model, r.inputTokens, r.outputTokens, cost ?? "", r.finishReason]
        .map((v) => {
          const s = String(v);
          return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",");
    });
    return [header, ...lines].join("\n");
  }

  /**
   * 导出成本报告为 JSON 字符串（带汇总）。
   */
  exportJSON(now: Date = new Date(), pricing?: UsagePricing): string {
    const records = this.readAll();
    const summary = this.summary(now, pricing);
    const daily = this.dailySummary(pricing);
    return JSON.stringify({ exportedAt: now.toISOString(), summary, daily, records }, null, 2);
  }
}
