/**
 * E2E 全量跑批器（v0.7.11：根治测试腐烂——verify-i11/i5 静默失效数月无人知晓）。
 *
 * 枚举 apps/desktop/tests/e2e/*.mjs（排除自身与共享工具），逐套运行并汇总：
 * 每套独立超时看护（单套卡死不拖垮整批）、逐套结果表、退出码=失败套数。
 * 供 nightly-e2e CI（每晚全量回归）与本地 `npm run test:e2e-all` 使用。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** 参与全量回归的脚本（按文件名排序执行；排除跑批器自身与 `_` 前缀手动工具）。 */
const allScripts = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".mjs") && name !== SELF && !name.startsWith("_"))
  .sort();

// 真实云端 LLM 套件（real-llm-*）：需要 DEEPSEEK_API_KEY——默认跳过，
// 设 DEVWIT_E2E_REAL_LLM=1 且提供 key 时纳入（自证成本可控的 opt-in 路径）
const realLlm = process.env.DEVIT_E2E_REAL_LLM === "1" || process.env.DEVWIT_E2E_REAL_LLM === "1";
const scripts = realLlm ? allScripts : allScripts.filter((name) => !name.startsWith("real-llm-"));
const skipped = allScripts.filter((name) => !scripts.includes(name));

/** 单套超时（毫秒）：最长套（编排/遥测）6 分钟足够；超时杀进程记失败。 */
const PER_SCRIPT_TIMEOUT_MS = 6 * 60_000;

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(dir, name)], {
      env: { ...process.env, DEVWIT_E2E_OFFSCREEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PER_SCRIPT_TIMEOUT_MS);
    let tail = "";
    const feed = (chunk) => {
      tail = (tail + chunk.toString()).slice(-1500);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        name,
        ok: !timedOut && code === 0,
        seconds: Math.round((Date.now() - started) / 1000),
        note: timedOut ? `超时（>${PER_SCRIPT_TIMEOUT_MS / 1000}s，已杀）` : code === 0 ? "" : `exit=${code}`,
        tail: tail.trim(),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ name, ok: false, seconds: 0, note: `spawn失败: ${error.message}`, tail: "" });
    });
  });
}

const results = [];
let index = 0;
// 串行执行：Electron 实例与临时端口隔离更稳，且失败定位清晰
for (const name of scripts) {
  index += 1;
  console.log(`[e2e-all ${index}/${scripts.length}] ${name} ...`);
  const result = await runOne(name);
  results.push(result);
  console.log(`[e2e-all] ${result.ok ? "PASS" : "FAIL"} ${result.name} (${result.seconds}s)${result.note ? ` — ${result.note}` : ""}`);
}

const failed = results.filter((r) => !r.ok);
console.log("\n==== E2E 全量汇总 ====");
for (const r of results) {
  console.log(`${r.ok ? "  ✓" : "  ✗"} ${r.name} (${r.seconds}s)${r.note ? ` ${r.note}` : ""}`);
}
for (const name of skipped) {
  console.log(`  - ${name}（跳过：real-llm 需凭证，DEVWIT_E2E_REAL_LLM=1 启用）`);
}
console.log(`共 ${results.length} 套：${results.length - failed.length} 通过，${failed.length} 失败，${skipped.length} 跳过`);
if (failed.length > 0) {
  console.log("\n失败套末尾输出（定位用）：");
  for (const r of failed) {
    console.log(`--- ${r.name} ---\n${r.tail}`);
  }
  process.exit(failed.length);
}
