import path from "node:path";
import type { AgentToolName, ToolCall, ToolDefinition, ToolResult } from "@devwit/contracts";

/**
 * 工具执行环境端口：agent-runtime 不直接碰 fs/child_process——
 * 真实实现由 createNodeEnvironment（shell.ts，真实 node:fs / node:child_process）
 * 或 apps 层注入的 workspace/terminal 服务提供；测试注入内存实现。
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ToolEnvironment {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  signal?: AbortSignal;
}

export type ToolHandler = (args: Record<string, unknown>, env: ToolEnvironment, ctx: ToolContext) => Promise<ToolResult>;

/** 单次工具输出上限（字符）：防止巨型文件/日志打爆上下文窗口。 */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;
const MAX_GREP_MATCHES = 200;
const MAX_FIND_RESULTS = 200;
const MAX_LS_ENTRIES = 500;
const MAX_WALK_ENTRIES = 10_000;
const MAX_WALK_DEPTH = 20;
const IGNORED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "out", "coverage", ".next", "build"]);

class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function fail(error: string, output = ""): ToolResult {
  return { ok: false, output, error };
}

function ok(output: string): ToolResult {
  return { ok: true, output: truncateOutput(output) };
}

/** 截断超长输出，附原始长度说明（可审计，不静默丢信息）。 */
export function truncateOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[输出过长已截断，共 ${text.length} 字符]`;
}

/** 路径安全：解析到工作区内，拒绝越界（如 ../、绝对路径跳出 root）。 */
export function resolveWithinRoot(root: string, target: string): string {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, target);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new ToolArgumentError(`路径越出工作区: ${target}`);
  }
  return resolved;
}

function displayPath(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new ToolArgumentError(`参数 ${key} 必须是非空字符串`);
  return value;
}

function requireContent(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new ToolArgumentError(`参数 ${key} 必须是字符串`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolArgumentError(`参数 ${key} 必须是字符串`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolArgumentError(`参数 ${key} 必须是布尔值`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolArgumentError(`参数 ${key} 必须是有限数字`);
  return value;
}

/** 通配符（* / ?）转正则，用于 find/grep 的文件名过滤。大小写不敏感。 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

interface WalkState {
  visited: number;
}

async function* walk(
  env: ToolEnvironment,
  dir: string,
  state: WalkState,
  depth: number
): AsyncGenerator<{ path: string; isDirectory: boolean }> {
  if (depth > MAX_WALK_DEPTH || state.visited >= MAX_WALK_ENTRIES) return;
  let entries: DirEntry[];
  try {
    entries = await env.listDir(dir);
  } catch {
    return; // 不可读目录跳过，不中断整体遍历
  }
  for (const entry of entries) {
    if (state.visited >= MAX_WALK_ENTRIES) return;
    const full = path.join(dir, entry.name);
    state.visited += 1;
    if (entry.isDirectory) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield { path: full, isDirectory: true };
      yield* walk(env, full, state, depth + 1);
    } else {
      yield { path: full, isDirectory: false };
    }
  }
}

// ============================================================================
// 七个内置工具（WU010）：read / write / edit / bash / grep / find / ls
// ============================================================================

const readHandler: ToolHandler = async (args, env, ctx) => {
  const target = resolveWithinRoot(ctx.workspaceRoot, requireString(args, "path"));
  const startLine = optionalNumber(args, "start_line");
  const endLine = optionalNumber(args, "end_line");
  try {
    const content = await env.readFile(target);
    // 行区间读取：大文件分片，避免一次性读全文打爆上下文（默认全文）。
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const total = lines.length;
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(total, endLine ?? total);
      if (start > end) return fail(`start_line(${start}) 大于 end_line(${end})，无有效区间`);
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
      return ok(
        `文件 ${displayPath(ctx.workspaceRoot, target)} 共 ${total} 行，显示第 ${start}-${end} 行：\n${numbered}`
      );
    }
    return ok(content);
  } catch (error) {
    return fail(`读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeHandler: ToolHandler = async (args, env, ctx) => {
  const target = resolveWithinRoot(ctx.workspaceRoot, requireString(args, "path"));
  const content = requireContent(args, "content");
  try {
    await env.writeFile(target, content);
  } catch (error) {
    return fail(`写入失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ok(`已写入 ${displayPath(ctx.workspaceRoot, target)}（${content.length} 字符）`);
};

const editHandler: ToolHandler = async (args, env, ctx) => {
  const target = resolveWithinRoot(ctx.workspaceRoot, requireString(args, "path"));
  const oldString = requireString(args, "old_string");
  const newString = requireContent(args, "new_string");
  const replaceAll = optionalBoolean(args, "replace_all") ?? false;
  let original: string;
  try {
    original = await env.readFile(target);
  } catch (error) {
    return fail(`读取失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const occurrences = original.split(oldString).length - 1;
  if (occurrences === 0) return fail(`old_string 在 ${displayPath(ctx.workspaceRoot, target)} 中未出现`);
  if (occurrences > 1 && !replaceAll) {
    return fail(`old_string 出现 ${occurrences} 次，非唯一；请提供更多上下文或设 replace_all=true`);
  }
  const updated = original.split(oldString).join(newString);
  try {
    await env.writeFile(target, updated);
  } catch (error) {
    return fail(`写入失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ok(`已在 ${displayPath(ctx.workspaceRoot, target)} 替换 ${replaceAll ? occurrences : 1} 处匹配`);
};

const bashHandler: ToolHandler = async (args, env, ctx) => {
  const command = requireString(args, "command");
  const timeoutMs = optionalNumber(args, "timeout_ms");
  let result: ExecResult;
  try {
    result = await env.exec(command, {
      cwd: ctx.workspaceRoot,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    return fail(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  const output = parts.length > 0 ? truncateOutput(parts.join("\n")) : "(无输出)";
  if (result.exitCode !== 0) return fail(`命令退出码 ${result.exitCode}`, output);
  return { ok: true, output };
};

const grepHandler: ToolHandler = async (args, env, ctx) => {
  const pattern = requireString(args, "pattern");
  const baseDir = resolveWithinRoot(ctx.workspaceRoot, optionalString(args, "path") ?? ".");
  const caseSensitive = optionalBoolean(args, "case_sensitive") ?? true;
  const glob = optionalString(args, "glob");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    return fail(`无效正则: ${error instanceof Error ? error.message : String(error)}`);
  }
  const nameFilter = glob !== undefined ? wildcardToRegExp(glob) : null;
  const matches: string[] = [];
  let skipped = 0;
  const state: WalkState = { visited: 0 };
  for await (const entry of walk(env, baseDir, state, 0)) {
    if (entry.isDirectory) continue;
    if (nameFilter && !nameFilter.test(path.basename(entry.path))) continue;
    let content: string;
    try {
      content = await env.readFile(entry.path);
    } catch {
      continue; // 二进制或不可读文件跳过
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || !regex.test(line)) continue;
      if (matches.length < MAX_GREP_MATCHES) {
        matches.push(`${displayPath(ctx.workspaceRoot, entry.path)}:${i + 1}: ${line}`);
      } else {
        skipped += 1;
      }
    }
  }
  const suffix = skipped > 0 ? `\n…[另有 ${skipped} 处匹配未列出]` : "";
  return ok(matches.length > 0 ? matches.join("\n") + suffix : `无匹配: ${pattern}`);
};

const findHandler: ToolHandler = async (args, env, ctx) => {
  const pattern = requireString(args, "pattern");
  const baseDir = resolveWithinRoot(ctx.workspaceRoot, optionalString(args, "path") ?? ".");
  const nameFilter = wildcardToRegExp(pattern);
  const results: string[] = [];
  let skipped = 0;
  const state: WalkState = { visited: 0 };
  for await (const entry of walk(env, baseDir, state, 0)) {
    if (!nameFilter.test(path.basename(entry.path))) continue;
    if (results.length < MAX_FIND_RESULTS) {
      results.push(displayPath(ctx.workspaceRoot, entry.path) + (entry.isDirectory ? "/" : ""));
    } else {
      skipped += 1;
    }
  }
  const suffix = skipped > 0 ? `\n…[另有 ${skipped} 个结果未列出]` : "";
  return ok(results.length > 0 ? results.join("\n") + suffix : `未找到: ${pattern}`);
};

const lsHandler: ToolHandler = async (args, env, ctx) => {
  const target = resolveWithinRoot(ctx.workspaceRoot, optionalString(args, "path") ?? ".");
  let entries: DirEntry[];
  try {
    entries = await env.listDir(target);
  } catch (error) {
    return fail(`列目录失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dirs = entries.filter((entry) => entry.isDirectory).map((entry) => `${entry.name}/`);
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name);
  const sorted = [...dirs.sort(), ...files.sort()];
  const shown = sorted.slice(0, MAX_LS_ENTRIES);
  const suffix = sorted.length > shown.length ? `\n…[另有 ${sorted.length - shown.length} 项未列出]` : "";
  return ok(shown.length > 0 ? shown.join("\n") + suffix : "(空目录)");
};

/**
 * Git 只读工具（git_*）：在 git 仓库内跑只读 git 命令并返回结果。
 * 只读免授权（AC4），与 bash 的"执行任意命令需授权"区分——git 只读不改变工作区。
 * 工作区非 git 仓库时返回明确错误（引导打开 git 仓库或先 git init）。
 */
async function runGit(cwd: string, env: ToolEnvironment, args: string[]): Promise<ToolResult> {
  let result: ExecResult;
  try {
    result = await env.exec(`git ${args.join(" ")}`, { cwd });
  } catch (error) {
    return fail(`git 执行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
  const output = parts.length > 0 ? truncateOutput(parts.join("\n")) : "(无输出)";
  if (result.exitCode !== 0) return fail(`git 退出码 ${result.exitCode}`, output);
  return { ok: true, output };
}

const gitStatusHandler: ToolHandler = async (_args, env, ctx) =>
  runGit(ctx.workspaceRoot, env, ["status", "--short"]);

const gitDiffHandler: ToolHandler = async (args, env, ctx) => {
  const pathArg = optionalString(args, "path");
  const staged = optionalBoolean(args, "staged") ?? false;
  const base = staged ? "--cached" : "";
  const rest = pathArg !== undefined && pathArg.trim() !== "" ? " --" : "";
  return runGit(ctx.workspaceRoot, env, ["diff", base, rest].filter((s) => s !== "").concat(pathArg !== undefined && pathArg.trim() !== "" ? [pathArg] : []));
};

const gitLogHandler: ToolHandler = async (args, env, ctx) => {
  const limit = optionalNumber(args, "limit") ?? 20;
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return runGit(ctx.workspaceRoot, env, ["log", `-${safeLimit}`, "--oneline", "--decorate"]);
};

const gitBranchHandler: ToolHandler = async (_args, env, ctx) =>
  runGit(ctx.workspaceRoot, env, ["branch", "--list", "--sort=-committerdate"]);

export const TOOL_HANDLERS: Readonly<Record<AgentToolName, ToolHandler>> = {
  read: readHandler,
  write: writeHandler,
  edit: editHandler,
  bash: bashHandler,
  grep: grepHandler,
  find: findHandler,
  ls: lsHandler,
  git_status: gitStatusHandler,
  git_diff: gitDiffHandler,
  git_log: gitLogHandler,
  git_branch: gitBranchHandler,
};

export function isAgentToolName(name: string): name is AgentToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name);
}

const PATH_PROPERTY = { type: "string", description: "相对工作区根的路径" } as const;

/** 七个内置工具的 JSON Schema 定义（发给 provider 的 tools 参数）。 */
export const TOOL_DEFINITIONS: Readonly<Record<AgentToolName, ToolDefinition>> = {
  read: {
    name: "read",
    description: "读取工作区内文件内容；可用 start_line/end_line 读取指定行区间（大文件分片阅读）",
    parameters: {
      type: "object",
      properties: {
        path: PATH_PROPERTY,
        start_line: { type: "number", description: "起始行号（从 1 起，可选）" },
        end_line: { type: "number", description: "结束行号（含，可选）" },
      },
      required: ["path"],
    },
  },
  write: {
    name: "write",
    description: "写入文件（覆盖式，自动创建父目录）。需用户授权",
    parameters: {
      type: "object",
      properties: { path: PATH_PROPERTY, content: { type: "string", description: "完整文件内容" } },
      required: ["path", "content"],
    },
  },
  edit: {
    name: "edit",
    description: "对文件做精确的字符串替换（old_string 须唯一，除非 replace_all=true）。需用户授权",
    parameters: {
      type: "object",
      properties: {
        path: PATH_PROPERTY,
        old_string: { type: "string", description: "被替换的原文（非空）" },
        new_string: { type: "string", description: "替换后的文本（可为空串表示删除）" },
        replace_all: { type: "boolean", description: "替换全部出现位置" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  bash: {
    name: "bash",
    description: "在工作区根目录执行 shell 命令并返回输出。需用户授权",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout_ms: { type: "number", description: "超时毫秒数（可选）" },
      },
      required: ["command"],
    },
  },
  grep: {
    name: "grep",
    description: "在工作区文件中按正则搜索，输出 文件:行号: 内容",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "起始目录（默认工作区根）" },
        glob: { type: "string", description: "文件名通配过滤，如 *.ts" },
        case_sensitive: { type: "boolean", description: "大小写敏感（默认 true）" },
      },
      required: ["pattern"],
    },
  },
  find: {
    name: "find",
    description: "按文件名通配符（* / ?）查找文件与目录",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "文件名通配符，如 *.ts" },
        path: { type: "string", description: "起始目录（默认工作区根）" },
      },
      required: ["pattern"],
    },
  },
  ls: {
    name: "ls",
    description: "列出目录内容（目录名带 / 后缀）",
    parameters: { type: "object", properties: { path: { type: "string", description: "目录路径（默认工作区根）" } } },
  },
  git_status: {
    name: "git_status",
    description: "查看 Git 工作区状态（git status --short）：改/删/暂存文件清单",
    parameters: { type: "object", properties: {} },
  },
  git_diff: {
    name: "git_diff",
    description: "查看 Git diff（未暂存默认；staged=true 看已暂存）。可按路径过滤",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "限定查看此路径的 diff（可选）" },
        staged: { type: "boolean", description: "true 查看已暂存（--cached）变更；默认 false" },
      },
    },
  },
  git_log: {
    name: "git_log",
    description: "查看 Git 提交历史（一行为一条：hash + 主题）",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "最近几条提交（默认 20，上限 100）" } },
    },
  },
  git_branch: {
    name: "git_branch",
    description: "列出 Git 本地分支（按最近提交时间倒序）",
    parameters: { type: "object", properties: {} },
  },
};

/** 按模式声明的工具名筛出合法的工具定义（忽略未知名）。 */
export function toolDefinitionsFor(names: readonly string[]): ToolDefinition[] {
  return names.filter(isAgentToolName).map((name) => TOOL_DEFINITIONS[name]);
}

/** 工具执行入口：参数错误与执行异常统一收敛为 ok=false 的 ToolResult。 */
export async function executeTool(call: ToolCall, env: ToolEnvironment, ctx: ToolContext): Promise<ToolResult> {
  if (!isAgentToolName(call.name)) return fail(`未知工具: ${call.name}`);
  try {
    return await TOOL_HANDLERS[call.name](call.args, env, ctx);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
