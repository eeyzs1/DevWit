/**
 * RegexMatchService（v0.7.5：grep 正则 worker 隔离）真实回环测试。
 * 真实 worker = packages/workspace 的 tsc 产物（构建链先 tsc -b 后测试）。
 * 覆盖：往返正确性、串行队列、灾难性回溯样本硬超时（null 而非挂死）、
 * worker 复用、dispose 回收。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RegexMatchService } from "../src/main/regex-matcher.js";

const REAL_WORKER = new URL("../../../packages/workspace/dist/search-worker.js", import.meta.url);

const services: RegexMatchService[] = [];

function makeService(): RegexMatchService {
  if (!fs.existsSync(fileURLToPath(REAL_WORKER))) {
    throw new Error("packages/workspace/dist/search-worker.js 缺失——先 tsc -b（构建链已保证）");
  }
  const service = new RegexMatchService(REAL_WORKER);
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe("RegexMatchService（worker 正则匹配）", () => {
  it("往返：逐行命中与进程内 RegExp.test 完全一致", async () => {
    const service = makeService();
    const lines = ["const hello = 1;", "no match here", "hello again", ""];
    const matched = await service.match(lines, "hello", "");
    expect(matched).toEqual([true, false, true, false]);
    // 大小写 flag 透传
    const insensitive = await service.match(lines, "HELLO", "i");
    expect(insensitive).toEqual([true, false, true, false]);
  });

  it("串行队列：并发请求逐个完成（单 worker 一次一个）", async () => {
    const service = makeService();
    const results = await Promise.all([
      service.match(["a"], "a", ""),
      service.match(["b"], "b", ""),
      service.match(["c"], "c", ""),
    ]);
    expect(results).toEqual([[true], [true], [true]]);
  });

  it("灾难性回溯样本（(a+)+$ vs 28 个 a）：短超时返回 null 而非挂死进程", async () => {
    const service = makeService();
    const evil = "a".repeat(28) + "!";
    const started = Date.now();
    const result = await service.match([evil, "ok line"], "(a+)+$", "", 1_500);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    // 超时后服务自愈：worker 重建，后续请求正常
    expect(await service.match(["recover"], "recover", "")).toEqual([true]);
  });

  it("worker 复用：两次成功请求后服务仍持有同一 worker 实例", async () => {
    const service = makeService();
    await service.match(["x"], "x", "");
    const first = (service as unknown as { worker: unknown }).worker;
    await service.match(["y"], "y", "");
    const second = (service as unknown as { worker: unknown }).worker;
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it("非法正则：worker 内编译失败 → ok:false → null（不抛穿）", async () => {
    const service = makeService();
    expect(await service.match(["a"], "([", "")).toBeNull();
    // 服务自愈（worker 被废弃后重建）
    expect(await service.match(["fine"], "fine", "")).toEqual([true]);
  });
});
