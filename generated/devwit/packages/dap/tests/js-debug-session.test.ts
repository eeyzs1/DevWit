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

    await session.start(program, { [program]: [2] });

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
});
