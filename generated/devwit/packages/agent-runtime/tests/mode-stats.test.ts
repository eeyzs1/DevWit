import { describe, expect, it } from "vitest";
import type { ModeRunStats } from "@devwit/contracts";
import { MIN_RUNS_FOR_RECOMMEND, ModeStatsTracker, parseModeRunStats } from "../src/mode-stats.js";

/** 内存 store：与 workflow-memory 测试同模式。 */
function makeStore(initial: ModeRunStats[] = []) {
  let stats = initial;
  return {
    get snapshot() {
      return stats;
    },
    read: () => stats,
    write: (next: ModeRunStats[]) => {
      stats = next;
    },
  };
}

const NOW = new Date("2026-07-25T10:00:00.000Z");

describe("parseModeRunStats（AC33 settings 反序列化）", () => {
  it("非数组/缺字段/脏数值条目丢弃", () => {
    expect(parseModeRunStats(undefined)).toEqual([]);
    expect(parseModeRunStats("x")).toEqual([]);
    expect(
      parseModeRunStats([
        { modeId: "agent", runs: 3, successes: 2, lastRunAt: "2026-07-25T00:00:00.000Z" },
        { modeId: "chat", runs: "3", successes: 1, lastRunAt: "2026-07-25T00:00:00.000Z" },
        { modeId: 42, runs: 1, successes: 1, lastRunAt: "2026-07-25T00:00:00.000Z" },
        { modeId: "orphan", runs: 1, successes: 1 },
        null,
      ])
    ).toEqual([{ modeId: "agent", runs: 3, successes: 2, lastRunAt: "2026-07-25T00:00:00.000Z" }]);
  });
});

describe("ModeStatsTracker.recordRun（AC33 定级累计）", () => {
  it("首次定级创建条目，成功/失败分别累计", () => {
    const store = makeStore();
    const tracker = new ModeStatsTracker(store);
    tracker.recordRun("agent", true, NOW);
    tracker.recordRun("agent", false, NOW);
    tracker.recordRun("agent", true, NOW);
    expect(store.snapshot).toEqual([
      { modeId: "agent", runs: 3, successes: 2, lastRunAt: NOW.toISOString() },
    ]);
  });

  it("多模式独立累计，lastRunAt 随定级刷新", () => {
    const store = makeStore();
    const tracker = new ModeStatsTracker(store);
    tracker.recordRun("agent", true, NOW);
    const later = new Date("2026-07-25T11:00:00.000Z");
    tracker.recordRun("chat", false, later);
    expect(store.snapshot).toEqual([
      { modeId: "agent", runs: 1, successes: 1, lastRunAt: NOW.toISOString() },
      { modeId: "chat", runs: 1, successes: 0, lastRunAt: later.toISOString() },
    ]);
  });
});

describe("ModeStatsTracker.successRate（AC33 成功率）", () => {
  it("无数据返回 null（与 0% 失败显式区分）", () => {
    const tracker = new ModeStatsTracker(makeStore());
    expect(tracker.successRate("agent")).toBeNull();
  });

  it("有数据返回 successes/runs", () => {
    const tracker = new ModeStatsTracker(
      makeStore([{ modeId: "agent", runs: 4, successes: 3, lastRunAt: NOW.toISOString() }])
    );
    expect(tracker.successRate("agent")).toBe(0.75);
  });
});

describe("ModeStatsTracker.shouldRecommend（AC33 推荐门槛与比较）", () => {
  it("相同模式不推荐", () => {
    const tracker = new ModeStatsTracker(
      makeStore([{ modeId: "agent", runs: 10, successes: 10, lastRunAt: NOW.toISOString() }])
    );
    expect(tracker.shouldRecommend("agent", "agent")).toBe(false);
  });

  it("候选定级数不足门槛不推荐（防单次侥幸）", () => {
    const tracker = new ModeStatsTracker(
      makeStore([{ modeId: "agent", runs: MIN_RUNS_FOR_RECOMMEND - 1, successes: MIN_RUNS_FOR_RECOMMEND - 1, lastRunAt: NOW.toISOString() }])
    );
    expect(tracker.shouldRecommend("agent", "chat")).toBe(false);
  });

  it("候选无数据不推荐", () => {
    const tracker = new ModeStatsTracker(makeStore());
    expect(tracker.shouldRecommend("agent", "chat")).toBe(false);
  });

  it("候选成功率 >= 当前推荐；当前无数据视为 0", () => {
    const tracker = new ModeStatsTracker(
      makeStore([
        { modeId: "agent", runs: 5, successes: 4, lastRunAt: NOW.toISOString() },
        { modeId: "chat", runs: 4, successes: 2, lastRunAt: NOW.toISOString() },
      ])
    );
    expect(tracker.shouldRecommend("agent", "chat")).toBe(true); // 0.8 >= 0.5
    expect(tracker.shouldRecommend("chat", "agent")).toBe(false); // 0.5 < 0.8
    expect(tracker.shouldRecommend("agent", "orphan")).toBe(true); // 当前无数据视为 0
  });

  it("成功率持平也推荐（不差于当前即可）", () => {
    const tracker = new ModeStatsTracker(
      makeStore([
        { modeId: "agent", runs: 3, successes: 3, lastRunAt: NOW.toISOString() },
        { modeId: "chat", runs: 2, successes: 2, lastRunAt: NOW.toISOString() },
      ])
    );
    expect(tracker.shouldRecommend("agent", "chat")).toBe(true);
  });
});
