/**
 * UsageStore 测试（迭代 26 / AC35）：真实 tmp 目录 JSONL 回环——
 * 追加/聚合（今日/累计/按模式/按服务商）/坏行容忍/清零/重启等价物（新实例读旧文件）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageRecord } from "@devwit/contracts";
import { UsageStore } from "../src/main/usage-store.js";

let dir: string;
let file: string;

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: new Date().toISOString(),
    sessionId: "s-1",
    modeId: "chat",
    providerId: "p-1",
    model: "m-1",
    inputTokens: 10,
    outputTokens: 5,
    finishReason: "completed",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "devwit-usage-store-"));
  file = path.join(dir, "usage.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("UsageStore（AC35 用量账本）", () => {
  it("空账本：summary 全零，readAll 空数组", () => {
    const store = new UsageStore(file);
    expect(store.readAll()).toEqual([]);
    const summary = store.summary();
    expect(summary.total).toEqual({ inputTokens: 0, outputTokens: 0, runs: 0 });
    expect(summary.today).toEqual({ inputTokens: 0, outputTokens: 0, runs: 0 });
    expect(summary.byMode).toEqual([]);
    expect(summary.byProvider).toEqual([]);
  });

  it("追加后聚合：累计/今日/按模式/按服务商", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 }));
    store.append(record({ inputTokens: 55, outputTokens: 9, sessionId: "s-2" }));
    store.append(record({ modeId: "agent", providerId: "p-2", model: "m-2", inputTokens: 100, outputTokens: 50 }));
    const summary = store.summary();
    expect(summary.total).toEqual({ inputTokens: 195, outputTokens: 74, runs: 3 });
    expect(summary.today).toEqual({ inputTokens: 195, outputTokens: 74, runs: 3 });
    expect(summary.byMode).toEqual([
      { modeId: "chat", inputTokens: 95, outputTokens: 24, runs: 2 },
      { modeId: "agent", inputTokens: 100, outputTokens: 50, runs: 1 },
    ]);
    expect(summary.byProvider).toEqual([
      { providerId: "p-1", model: "m-1", inputTokens: 95, outputTokens: 24, runs: 2 },
      { providerId: "p-2", model: "m-2", inputTokens: 100, outputTokens: 50, runs: 1 },
    ]);
  });

  it("昨日记录不计入今日但计入累计", () => {
    const store = new UsageStore(file);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    store.append(record({ ts: yesterday, inputTokens: 7, outputTokens: 3 }));
    store.append(record({ inputTokens: 10, outputTokens: 5 }));
    const summary = store.summary();
    expect(summary.total).toEqual({ inputTokens: 17, outputTokens: 8, runs: 2 });
    expect(summary.today).toEqual({ inputTokens: 10, outputTokens: 5, runs: 1 });
  });

  it("新实例读旧文件（重启等价物）：聚合结果一致", () => {
    const first = new UsageStore(file);
    first.append(record({ inputTokens: 40, outputTokens: 15 }));
    const second = new UsageStore(file);
    expect(second.summary().total).toEqual({ inputTokens: 40, outputTokens: 15, runs: 1 });
  });

  it("坏行容忍：非法 JSON 行跳过，合法行照常聚合", () => {
    writeFileSync(file, `{"ts":"broken\n${JSON.stringify(record({ inputTokens: 3, outputTokens: 2 }))}\n`, "utf-8");
    const store = new UsageStore(file);
    expect(store.readAll()).toHaveLength(1);
    expect(store.summary().total).toEqual({ inputTokens: 3, outputTokens: 2, runs: 1 });
  });

  it("字段不完整的行视为坏行跳过", () => {
    writeFileSync(file, `{"ts":"2026-07-25T00:00:00.000Z"}\n${JSON.stringify(record())}\n`, "utf-8");
    const store = new UsageStore(file);
    expect(store.readAll()).toHaveLength(1);
  });

  it("清零：文件删除，summary 归零；无文件时清零为空操作", () => {
    const store = new UsageStore(file);
    store.append(record());
    expect(existsSync(file)).toBe(true);
    store.clear();
    expect(existsSync(file)).toBe(false);
    expect(store.summary().total.runs).toBe(0);
    store.clear(); // 再次清零不抛
  });
});

describe("UsageStore 成本估算（迭代 27 / AC36）", () => {
  it("按单价逐记录估算成本：total/today/byMode/byProvider 同步累加", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 })); // p-1 m-1
    store.append(record({ inputTokens: 100, outputTokens: 50, sessionId: "s-2" }));
    // 单价：input 2 元/百万、output 8 元/百万
    // 记录1：(40*2 + 15*8)/1e6 = 0.0002；记录2：(100*2 + 50*8)/1e6 = 0.0006
    const pricing = { "p-1 m-1": { inputPerMillion: 2, outputPerMillion: 8 } };
    const summary = store.summary(new Date(), pricing);
    expect(summary.total.cost).toBeCloseTo(0.0008, 10);
    expect(summary.total.unpricedRuns).toBeUndefined();
    expect(summary.today.cost).toBeCloseTo(0.0008, 10);
    expect(summary.byMode[0]!.cost).toBeCloseTo(0.0008, 10);
    expect(summary.byProvider[0]!.cost).toBeCloseTo(0.0008, 10);
  });

  it("部分覆盖：未匹配单价的记录计入 unpricedRuns，不虚构成本", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 })); // 有单价
    store.append(record({ providerId: "p-2", model: "m-2", inputTokens: 100, outputTokens: 50 })); // 无单价
    const pricing = { "p-1 m-1": { inputPerMillion: 2, outputPerMillion: 8 } };
    const summary = store.summary(new Date(), pricing);
    expect(summary.total.cost).toBeCloseTo(0.0002, 10); // 仅已定价记录的成本
    expect(summary.total.unpricedRuns).toBe(1);
    // byMode 同一模式聚合两条：成本与未定价计数并存
    expect(summary.byMode[0]!.runs).toBe(2);
    expect(summary.byMode[0]!.cost).toBeCloseTo(0.0002, 10);
    expect(summary.byMode[0]!.unpricedRuns).toBe(1);
    // byProvider 分行：p-2 行只有 unpricedRuns，无 cost
    const p2 = summary.byProvider.find((row) => row.providerId === "p-2")!;
    expect(p2.cost).toBeUndefined();
    expect(p2.unpricedRuns).toBe(1);
  });

  it("非法单价项（负数/非数）按未定价处理", () => {
    const store = new UsageStore(file);
    store.append(record());
    const pricing = { "p-1 m-1": { inputPerMillion: -1, outputPerMillion: Number.NaN } };
    const summary = store.summary(new Date(), pricing);
    expect(summary.total.cost).toBeUndefined();
    expect(summary.total.unpricedRuns).toBe(1);
  });

  it("零单价合法：成本为 0 而非未定价", () => {
    const store = new UsageStore(file);
    store.append(record());
    const pricing = { "p-1 m-1": { inputPerMillion: 0, outputPerMillion: 0 } };
    const summary = store.summary(new Date(), pricing);
    expect(summary.total.cost).toBe(0);
    expect(summary.total.unpricedRuns).toBeUndefined();
  });

  it("不传 pricing：无 cost 与 unpricedRuns 字段（向后兼容）", () => {
    const store = new UsageStore(file);
    store.append(record());
    const summary = store.summary();
    expect(summary.total).toEqual({ inputTokens: 10, outputTokens: 5, runs: 1 });
    expect(summary.total.cost).toBeUndefined();
    expect(summary.total.unpricedRuns).toBeUndefined();
  });
});

describe("UsageStore 按日/按会话汇总", () => {
  it("byDate 按日期聚合并排序，返回最近 30 天", () => {
    const store = new UsageStore(file);
    const today = new Date();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    store.append(record({ ts: yesterday.toISOString(), inputTokens: 40, outputTokens: 15 }));
    store.append(record({ ts: today.toISOString(), inputTokens: 10, outputTokens: 5 }));
    store.append(record({ ts: today.toISOString(), inputTokens: 20, outputTokens: 10, sessionId: "s-2" }));

    const daily = store.dailySummary();
    expect(daily.byDate).toHaveLength(2);
    // 按日期升序
    expect(daily.byDate[0]!.inputTokens).toBe(40);
    expect(daily.byDate[1]!.inputTokens).toBe(30); // 今日两条合并
    expect(daily.byDate[1]!.runs).toBe(2);
  });

  it("bySession 按会话聚合", () => {
    const store = new UsageStore(file);
    store.append(record({ sessionId: "proj-a", inputTokens: 100, outputTokens: 50 }));
    store.append(record({ sessionId: "proj-b", inputTokens: 30, outputTokens: 10 }));
    store.append(record({ sessionId: "proj-a", inputTokens: 50, outputTokens: 20 }));

    const daily = store.dailySummary();
    expect(daily.bySession).toHaveLength(2);
    // proj-a 总计 150 input + 70 output
    const a = daily.bySession.find((s) => s.sessionId === "proj-a")!;
    expect(a.inputTokens).toBe(150);
    expect(a.outputTokens).toBe(70);
    expect(a.runs).toBe(2);
  });

  it("空账本：byDate 和 bySession 为空数组", () => {
    const store = new UsageStore(file);
    const daily = store.dailySummary();
    expect(daily.byDate).toEqual([]);
    expect(daily.bySession).toEqual([]);
  });

  it("带 pricing：cost 正确累加到 byDate 和 bySession", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 }));
    const pricing = { "p-1 m-1": { inputPerMillion: 2, outputPerMillion: 8 } };
    const daily = store.dailySummary(pricing);
    // (40*2 + 15*8)/1e6 = 0.0002
    expect(daily.byDate[0]!.cost).toBeCloseTo(0.0002, 10);
    expect(daily.bySession[0]!.cost).toBeCloseTo(0.0002, 10);
  });
});

describe("UsageStore 成本预警", () => {
  const pricing = { "p-1 m-1": { inputPerMillion: 2, outputPerMillion: 8 } };

  it("total 周期：成本超阈值时 exceeded=true", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 500_000, outputTokens: 200_000 }));
    // cost = (500000*2 + 200000*8)/1e6 = 2.6
    const alert = store.checkBudget(2.0, "total", new Date(), pricing);
    expect(alert.exceeded).toBe(true);
    expect(alert.current).toBeCloseTo(2.6, 6);
  });

  it("total 周期：成本未超阈值时 exceeded=false", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 100, outputTokens: 50 }));
    const alert = store.checkBudget(1.0, "total", new Date(), pricing);
    expect(alert.exceeded).toBe(false);
  });

  it("day 周期：仅计算今日记录", () => {
    const store = new UsageStore(file);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    store.append(record({ ts: yesterday.toISOString(), inputTokens: 500_000, outputTokens: 200_000 }));
    store.append(record({ inputTokens: 100, outputTokens: 50 }));
    // 昨日成本 2.6，今日成本 ~0.0006
    const alert = store.checkBudget(1.0, "day", new Date(), pricing);
    expect(alert.exceeded).toBe(false);
    expect(alert.current).toBeCloseTo(0.0006, 6);
  });

  it("无 pricing：current=0, exceeded=false（无法计算成本）", () => {
    const store = new UsageStore(file);
    store.append(record());
    const alert = store.checkBudget(0.001, "total");
    expect(alert.current).toBe(0);
    expect(alert.exceeded).toBe(false);
  });

  it("空账本：current=0, exceeded=false", () => {
    const store = new UsageStore(file);
    const alert = store.checkBudget(1.0, "total", new Date(), pricing);
    expect(alert.current).toBe(0);
    expect(alert.exceeded).toBe(false);
  });
});

describe("UsageStore 导出报告", () => {
  const pricing = { "p-1 m-1": { inputPerMillion: 2, outputPerMillion: 8 } };

  it("CSV：表头+数据行，含成本列", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 }));
    store.append(record({ inputTokens: 100, outputTokens: 50, sessionId: "s-2" }));
    const csv = store.exportCSV(pricing);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("ts,sessionId,modeId,providerId,model,inputTokens,outputTokens,cost,finishReason");
    expect(lines).toHaveLength(3); // header + 2 records
    // 第一条记录成本 = (40*2 + 15*8)/1e6 = 0.0002
    expect(lines[1]).toContain("0.0002");
  });

  it("CSV：无 pricing 时 cost 列为空", () => {
    const store = new UsageStore(file);
    store.append(record());
    const csv = store.exportCSV();
    const lines = csv.split("\n");
    expect(lines[1]).toContain(",,").not.toBe(false); // cost 列空
  });

  it("CSV：含逗号的字段正确转义", () => {
    const store = new UsageStore(file);
    store.append(record({ finishReason: "stop,sequence" }));
    const csv = store.exportCSV();
    expect(csv).toContain('"stop,sequence"');
  });

  it("JSON：包含 exportedAt/summary/daily/records", () => {
    const store = new UsageStore(file);
    store.append(record({ inputTokens: 40, outputTokens: 15 }));
    const json = store.exportJSON(new Date(), pricing);
    const parsed = JSON.parse(json);
    expect(parsed.exportedAt).toBeDefined();
    expect(parsed.summary.total.runs).toBe(1);
    expect(parsed.daily.byDate).toHaveLength(1);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.summary.total.cost).toBeCloseTo(0.0002, 10);
  });

  it("空账本导出：CSV 仅表头，JSON 空记录", () => {
    const store = new UsageStore(file);
    const csv = store.exportCSV();
    expect(csv.split("\n")).toHaveLength(1);
    const json = JSON.parse(store.exportJSON());
    expect(json.records).toEqual([]);
  });
});
