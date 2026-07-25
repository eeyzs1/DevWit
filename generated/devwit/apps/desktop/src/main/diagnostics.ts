import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiagnosticEntry } from "@devwit/contracts";

/**
 * tsc 诊断采集（迭代 21 / AC30）：agent 编辑文件后对工作区跑 `tsc --noEmit`，
 * 把编译错误结构化后回馈给下一轮 agent 上下文（修复闭环）。
 *
 * 诚实降级原则（不伪造诊断能力）：
 * - 工作区无 tsconfig.json → []（非 TS 项目没什么可诊断的）；
 * - 工作区未安装本地 typescript（node_modules/typescript/bin/tsc 缺失）→ []
 *   （不用 npx 联网拉取、不用全局 tsc——版本不可控且偏离项目真实编译环境）；
 * - tsc 崩溃/超时被杀 → []（诊断是增强回馈，绝不能阻断 agent 主循环）。
 */

/** 单次诊断上限：防超大仓库刷屏耗尽上下文 token。 */
const MAX_ENTRIES = 50;
/** tsc 进程超时（大仓库首次增量编译可能较慢）。 */
const TSC_TIMEOUT_MS = 60_000;

/**
 * 解析 `tsc --noEmit --pretty false` 输出。
 * 行格式：<file>(<line>,<col>): error TS<code>: <message>
 * （--pretty false 保证单行无颜色码；file 可能含空格，故从行尾特征反向锚定。）
 */
export function parseTscOutput(output: string, workspaceRoot: string): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  // 锚定 "(行,列): error|warning TS码: " 结构；文件路径段允许任意字符（含空格/括号）
  const pattern = /^(.*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
  for (const line of output.split(/\r?\n/)) {
    if (entries.length >= MAX_ENTRIES) break;
    const match = pattern.exec(line.trim());
    if (match === null) continue;
    const [, rawFile, rawLine, rawCol, severity, code, message] = match;
    if (rawFile === undefined || rawLine === undefined || rawCol === undefined) continue;
    // 归一化为工作区相对路径（正斜杠），绝对路径在注入上下文与轨迹中更冗长且泄漏机器目录
    const absolute = path.isAbsolute(rawFile) ? rawFile : path.resolve(workspaceRoot, rawFile);
    const relative = path.relative(workspaceRoot, absolute);
    const file = (relative.startsWith("..") ? rawFile : relative).split(path.sep).join("/");
    entries.push({
      file,
      line: Number(rawLine),
      column: Number(rawCol),
      severity: severity === "warning" ? "warning" : "error",
      code,
      message: message ?? "",
    });
  }
  return entries;
}

/** 跑工作区本地 tsc --noEmit 并解析诊断；无诊断能力时返回 []。 */
export async function collectTscDiagnostics(workspaceRoot: string): Promise<DiagnosticEntry[]> {
  if (!fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) return [];
  const tscBin = path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tscBin)) return [];
  const output = await runTsc(tscBin, workspaceRoot);
  if (output === null) return [];
  return parseTscOutput(output, workspaceRoot);
}

function runTsc(tscBin: string, workspaceRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(process.execPath, [tscBin, "--noEmit", "--pretty", "false"], {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null); // 超时：降级为空，不阻断 agent
    }, TSC_TIMEOUT_MS);
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf-8");
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // tsc 约定：0=无错误，1/2=有诊断（输出在 stdout）；异常退出码且无输出 → 降级
      const combined = out.length > 0 ? out : err;
      if (code === null || combined.trim().length === 0) {
        resolve(code === 0 ? "" : null);
        return;
      }
      resolve(combined);
    });
  });
}
