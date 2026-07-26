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
