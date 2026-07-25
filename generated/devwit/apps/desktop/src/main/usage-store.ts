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
import type { UsageRecord, UsageSummary, UsageTotals } from "@devwit/contracts";

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

  /** 聚合视图：今日（本地日）/累计/按模式/按服务商（同名服务商不同型号分行）。 */
  summary(now: Date = new Date()): UsageSummary {
    const todayKey = localDateKey(now);
    const total = emptyTotals();
    const today = emptyTotals();
    const byMode = new Map<string, UsageTotals>();
    const byProvider = new Map<string, { providerId: string; model: string } & UsageTotals>();
    for (const record of this.readAll()) {
      total.inputTokens += record.inputTokens;
      total.outputTokens += record.outputTokens;
      total.runs += 1;
      const recordDate = new Date(record.ts);
      if (!Number.isNaN(recordDate.getTime()) && localDateKey(recordDate) === todayKey) {
        today.inputTokens += record.inputTokens;
        today.outputTokens += record.outputTokens;
        today.runs += 1;
      }
      const modeTotals = byMode.get(record.modeId) ?? emptyTotals();
      modeTotals.inputTokens += record.inputTokens;
      modeTotals.outputTokens += record.outputTokens;
      modeTotals.runs += 1;
      byMode.set(record.modeId, modeTotals);
      const providerKey = `${record.providerId}${record.model}`;
      const providerTotals =
        byProvider.get(providerKey) ?? { providerId: record.providerId, model: record.model, ...emptyTotals() };
      providerTotals.inputTokens += record.inputTokens;
      providerTotals.outputTokens += record.outputTokens;
      providerTotals.runs += 1;
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
}
