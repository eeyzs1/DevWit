/**
 * JsDebugSession 单测（迭代 33 / AC42）：真实 js-debug 适配器全链路。
 *
 * 零 mock：spawn 真实 vendor/js-debug dapDebugServer.js（微软官方发行版 v1.102.0），
 * 调试真实 temp fixture 程序——断点命中/变量读取/步进/求值/退出收尾全部真机断言。
 * nodeCommand = vitest 所在 node（开发环境真实 node，生产注入 Electron-as-node）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsDebugSession, type DebugState } from "../src/js-debug-session.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER = path.join(ROOT, "vendor", "js-debug", "src", "dapDebugServer.js");

/** fixture 行号（1-based）：1 const a / 2 const b（断点）/ 3 console.log */
const PROGRAM = ["const a = 1;", "const b = a + 41;", 'console.log("b=" + b);', ""].join("\n");

/**
 * 循环 fixture（v0.4.0 条件断点 / Log point 测试）：
 * 行 1 `for (let i = 0; i < 10; i++) {` / 行 2 `  console.log("iter=" + i);` / 行 3 `}`
 * 行 2 在循环里被命中 10 次（i=0..9）——
 * - condition "i === 5" 断点：只在 i=5 时暂停，求值 i 应得 5；
 * - logMessage "LP i={i}" 日志断点：不暂停，输出含 10 条 "LP i=0".."LP i=9"。
 */
const PROGRAM_LOOP = ['for (let i = 0; i < 10; i++) {', '  console.log("iter=" + i);', '}', ''].join("\n");

function makeSession(): { session: JsDebugSession; states: DebugState[]; outputs: string[] } {
  const states: DebugState[] = [];
  const outputs: string[] = [];
  const session = new JsDebugSession({
    serverPath: SERVER,
    nodeCommand: process.execPath,
    requestTimeoutMs: 15_000,
  });
  session.onState = (state) => states.push(state);
  session.onOutput = (_category, text) => outputs.push(text);
  return { session, states, outputs };
}

/** 轮询直到 fn() 返回真值（返回其值），超时返回 null。 */
async function pollUntil<T>(fn: () => T | null, timeoutMs = 10_000, intervalMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Windows 路径归一：js-debug 经 CDP 回传的盘符是小写（c:\…），os.tmpdir() 是大写（C:\…），
 * 同一文件仅盘符大小写之差——断言前统一大写盘符。
 */
function normDrive(p: string): string {
  return p.replace(/^[a-z]:/, (m) => m.toUpperCase());
}

describe("JsDebugSession 真实适配器", () => {
  let session: JsDebugSession | null = null;
  afterEach(async () => {
    await session?.shutdown();
    session = null;
  });

  it("断点命中 → 变量/求值 → 单步 → 继续至退出（全链路真实）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-test-"));
    const program = path.join(dir, "main.js");
    fs.writeFileSync(program, PROGRAM, "utf-8");

    const made = makeSession();
    session = made.session;
    const { states, outputs } = made;

    await session.start(program, { [program]: [{ line: 2 }] });

    // 断点命中：stopped 态 + 栈顶定位行 2（fillTopFrame 异步补齐，轮询等待）
    const stopped = await pollUntil(() => {
      const s = states.at(-1);
      return s?.state === "stopped" && s.line !== undefined ? s : null;
    });
    expect(stopped).not.toBeNull();
    expect(stopped?.state === "stopped" ? stopped.reason : "").toBe("breakpoint");
    expect(stopped?.state === "stopped" ? stopped.line : 0).toBe(2);
    expect(stopped?.state === "stopped" && stopped.file !== undefined ? normDrive(stopped.file) : "").toBe(normDrive(program));
    const threadId = stopped?.state === "stopped" ? stopped.threadId : -1;
    expect(threadId).toBeGreaterThanOrEqual(0); // js-debug 伴随会话线程 id 是 opaque 值（实测可为 0），能取栈即有效

    // 调用栈：栈顶 main 模块，行 2
    const frames = await session.stack();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.line).toBe(2);
    expect(frames[0]?.file !== undefined ? normDrive(frames[0].file) : "").toBe(normDrive(program));

    // 作用域变量：Local 含 a=1（b 尚未执行赋值）
    const scopes = await session.scopes(frames[0]?.id ?? 0);
    expect(scopes.length).toBeGreaterThan(0);
    const local = scopes.find((s) => /local/i.test(s.name)) ?? scopes[0];
    expect(local).toBeDefined();
    const vars = await session.variables(local?.variablesReference ?? 0);
    const varA = vars.find((v) => v.name === "a");
    expect(varA?.value).toBe("1");

    // 求值：a + 41 = 42（暂停上下文真实求值）
    const evaluated = await session.evaluate("a + 41", frames[0]?.id);
    expect(evaluated.value).toBe("42");

    // 单步跳过：行 2 → 行 3
    await session.next();
    const stoppedNext = await pollUntil(() => {
      const s = states.at(-1);
      return s?.state === "stopped" && s.line === 3 ? s : null;
    });
    expect(stoppedNext).not.toBeNull();

    // 继续：程序跑完退出 → terminated + console 输出回传
    await session.continue();
    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();
    const outText = outputs.join("");
    expect(outText).toContain("b=42");
  }, 30_000);

  it("无断点直接跑完：start 后 terminated，输出回传", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-test-"));
    const program = path.join(dir, "hello.js");
    fs.writeFileSync(program, 'console.log("hello-dap");\n', "utf-8");

    const made = makeSession();
    session = made.session;
    const { states, outputs } = made;
    await session.start(program, {});

    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();
    expect(outputs.join("")).toContain("hello-dap");
  }, 30_000);

  it("活动会话重复 start 拒绝 DW_DAP_ALREADY_ACTIVE；stop 幂等", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-test-"));
    const program = path.join(dir, "loop.js");
    fs.writeFileSync(program, "setInterval(() => {}, 1000);\n", "utf-8");

    const made = makeSession();
    session = made.session;
    await session.start(program, {});
    await expect(session.start(program, {})).rejects.toThrow("DW_DAP_ALREADY_ACTIVE");
    await session.shutdown();
    await session.shutdown(); // 幂等
    expect(session.currentState.state).toBe("terminated");
  }, 30_000);

  it("未暂停时步进/查询拒绝 DW_DAP_NOT_STOPPED", async () => {
    const made = makeSession();
    session = made.session;
    await expect(session.stack()).rejects.toThrow("DW_DAP_NOT_STOPPED");
    await expect(session.variables(1)).rejects.toThrow("DW_DAP_NOT_STOPPED");
    await expect(session.evaluate("1")).rejects.toThrow("DW_DAP_NOT_STOPPED");
  });

  it("条件断点：condition 为真才暂停（i === 5）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-cond-"));
    const program = path.join(dir, "loop.js");
    fs.writeFileSync(program, PROGRAM_LOOP, "utf-8");

    const made = makeSession();
    session = made.session;
    const { states } = made;

    // 条件断点：行 2 仅在 i === 5 时暂停
    await session.start(program, { [program]: [{ line: 2, condition: "i === 5" }] });

    const stopped = await pollUntil(() => {
      const s = states.at(-1);
      return s?.state === "stopped" && s.line !== undefined ? s : null;
    });
    expect(stopped).not.toBeNull();
    expect(stopped?.state === "stopped" ? stopped.line : 0).toBe(2);

    // 暂停时 i 必须为 5（条件断点语义验证）
    const frames = await session.stack();
    const evaluated = await session.evaluate("i", frames[0]?.id);
    expect(evaluated.value).toBe("5");

    // 继续后程序应跑完退出（不再被条件命中）
    await session.continue();
    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();
  }, 30_000);

  it("日志断点：logMessage 不暂停，输出含插值结果", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-log-"));
    const program = path.join(dir, "loop.js");
    fs.writeFileSync(program, PROGRAM_LOOP, "utf-8");

    const made = makeSession();
    session = made.session;
    const { states, outputs } = made;

    // 日志断点：行 2 不暂停，打印 "LP i={i}"（js-debug {expr} 插值）
    await session.start(program, { [program]: [{ line: 2, logMessage: "LP i={i}" }] });

    // 程序应直接跑完退出（日志断点不暂停 → 无 stopped 态）
    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();

    // 全程不应出现 stopped 态（日志断点语义验证）
    const anyStopped = states.some((s) => s.state === "stopped");
    expect(anyStopped).toBe(false);

    // 输出应含 10 条日志断点输出（LP i=0 .. LP i=9）
    const outText = outputs.join("");
    expect(outText).toContain("LP i=0");
    expect(outText).toContain("LP i=9");
    // console.log 自身输出也应存在
    expect(outText).toContain("iter=0");
  }, 30_000);

  it("命中次数断点：hitCount=5 仅第 5 次命中时暂停", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-hit-"));
    const program = path.join(dir, "loop.js");
    fs.writeFileSync(program, PROGRAM_LOOP, "utf-8");

    const made = makeSession();
    session = made.session;
    const { states } = made;

    // hitCount=5：行 2 命中 5 次后才暂停（js-debug hitCondition "5" 语义）
    await session.start(program, { [program]: [{ line: 2, hitCount: 5 }] });

    const stopped = await pollUntil(() => {
      const s = states.at(-1);
      return s?.state === "stopped" && s.line !== undefined ? s : null;
    });
    expect(stopped).not.toBeNull();

    // 第 5 次命中时 i=4（i 从 0 开始，第 5 次 = i=4）
    const frames = await session.stack();
    const evaluated = await session.evaluate("i", frames[0]?.id);
    expect(evaluated.value).toBe("4");

    await session.continue();
    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();
  }, 30_000);

  it("动态 setBreakpoints：会话中下发条件断点并命中", async () => {
    // 长跑程序：setInterval 保活，断点目标行在回调内（每 50ms 命中一次）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-dap-dyn-"));
    const program = path.join(dir, "loop.js");
    // 行 1 let i=0 / 行 2 setInterval(() => { / 行 3   i++;（断点目标，循环内）/ 行 4 }, 50);
    fs.writeFileSync(program, ["let i = 0;", "setInterval(() => {", "  i++;", "}, 50);", ""].join("\n"), "utf-8");

    const made = makeSession();
    session = made.session;
    const { states } = made;

    // 启动时无断点 → 程序进入 setInterval 长跑
    await session.start(program, {});
    // 动态下发条件断点：行 3（i++ 在回调内循环执行）仅在 i === 3 时暂停
    await session.setBreakpoints(program, [{ line: 3, condition: "i === 3" }]);

    // 条件断点应在 i===3 时命中（i 在第 3 次 interval 后变为 3，第 4 次 line3 执行前条件为真）
    const stopped = await pollUntil(() => {
      const s = states.at(-1);
      return s?.state === "stopped" && s.line !== undefined ? s : null;
    });
    expect(stopped).not.toBeNull();
    expect(stopped?.state === "stopped" ? stopped.line : 0).toBe(3);

    const frames = await session.stack();
    const evaluated = await session.evaluate("i", frames[0]?.id);
    expect(evaluated.value).toBe("3");

    // 清除断点后继续 → 程序应长跑不再暂停（验证动态清除生效）
    await session.setBreakpoints(program, []);
    await session.continue();
    // 等待一段时间确认不再命中（无新 stopped 态）
    const beforeCount = states.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterStates = states.slice(beforeCount);
    expect(afterStates.some((s) => s.state === "stopped")).toBe(false);

    await session.shutdown();
    const terminated = await pollUntil(() => (states.at(-1)?.state === "terminated" ? states.at(-1) : null));
    expect(terminated).not.toBeNull();
  }, 30_000);
});
