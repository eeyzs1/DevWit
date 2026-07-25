/**
 * 社区 MCP 服务器索引客户端（迭代 25 / AC34：插件市场原型——模式+MCP 服务器双类型分发）。
 *
 * 与社区模式（AC25）同一索引仓库、同一信封（kind=devwit-modes-index, version=1）：
 * `mcpServers` 为可选新增段——JSON 向前兼容，缺字段按空数组，不 bump 版本
 * （旧客户端忽略未知段，新客户端读到就用）。
 *
 * 条目文件是独立信封（kind=devwit-mcp-server, version=1），负载不含 id——
 * id 由导入方生成（跨机器无意义且防冲突），装入后经 validateMcpServerConfig
 * 与手工录入同一标准校验。全部失败抛 ASCII 错误码（DW_MCP_INDEX_* / DW_MCP_SERVER_*），
 * 渲染端 localizeError 本地化。
 *
 * base URL 复用模式侧同一 env 覆盖（DEVWIT_MODES_INDEX_URL）：e2e 注入本地 server，
 * 生产缺省官方仓库。
 */
import type { CommunityMcpEntry, McpServerConfig } from "@devwit/contracts";
import { validateMcpServerConfig } from "./manager.js";

export const MCP_SERVER_KIND = "devwit-mcp-server";
export const MCP_SERVER_VERSION = 1;

/** 索引信封（与模式侧一致，此处独立声明防跨包耦合）。 */
const INDEX_KIND = "devwit-modes-index";
const INDEX_VERSION = 1;

/** fetch 的最小结构依赖（Node 20 全局 fetch 天然满足）。 */
export interface CommunityFetchLike {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

async function fetchText(url: string, fetchImpl: CommunityFetchLike): Promise<string> {
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchImpl(url);
  } catch {
    throw new Error("DW_MCP_INDEX_UNREACHABLE");
  }
  if (!res.ok) throw new Error(`DW_MCP_INDEX_HTTP:${String(res.status)}`);
  return res.text();
}

/** 条目 file 字段防路径穿越：拼接 base URL 前拒绝绝对路径与 ..（与模式侧同规则）。 */
function assertSafeRelativeFile(file: string): void {
  if (file === "" || file.startsWith("/") || file.includes("..") || /^[a-zA-Z]:[\\/]/.test(file)) {
    throw new Error("DW_MCP_INDEX_INVALID_SCHEMA");
  }
}

function readEntry(raw: unknown): CommunityMcpEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("DW_MCP_INDEX_INVALID_SCHEMA");
  const entry = raw as Record<string, unknown>;
  for (const field of ["file", "name", "description", "author"] as const) {
    if (typeof entry[field] !== "string" || (entry[field] as string).trim() === "") {
      throw new Error("DW_MCP_INDEX_INVALID_SCHEMA");
    }
  }
  const tools = entry["tools"];
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))) {
    throw new Error("DW_MCP_INDEX_INVALID_SCHEMA");
  }
  const file = (entry["file"] as string).trim();
  assertSafeRelativeFile(file);
  return {
    file,
    name: (entry["name"] as string).trim(),
    description: entry["description"] as string,
    author: (entry["author"] as string).trim(),
    tools: tools === undefined ? [] : (tools as string[]),
  };
}

/**
 * 解析索引文本中的 mcpServers 段：信封 kind/version 校验 + 逐条目 schema 校验。
 * mcpServers 缺字段按空数组（可选段向前兼容）；存在则必须是数组。
 */
export function parseMcpIndex(text: string): CommunityMcpEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("DW_MCP_INDEX_INVALID_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("DW_MCP_INDEX_INVALID_JSON");
  const index = raw as Record<string, unknown>;
  if (index["kind"] !== INDEX_KIND) throw new Error("DW_MCP_INDEX_NOT_AN_INDEX");
  if (index["version"] !== INDEX_VERSION) {
    throw new Error(`DW_MCP_INDEX_UNSUPPORTED_VERSION:${String(index["version"])}`);
  }
  const servers = index["mcpServers"];
  if (servers === undefined) return [];
  if (!Array.isArray(servers)) throw new Error("DW_MCP_INDEX_INVALID_SCHEMA");
  return servers.map(readEntry);
}

/** 拉取索引 mcpServers 段：GET <base>/index.json。 */
export async function fetchCommunityMcpIndex(base: string, fetchImpl: CommunityFetchLike): Promise<CommunityMcpEntry[]> {
  return parseMcpIndex(await fetchText(`${base}/index.json`, fetchImpl));
}

/** 社区服务器文件负载（无 id——id 由导入方生成）。 */
export interface McpServerFilePayload {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpServerFile {
  kind: typeof MCP_SERVER_KIND;
  version: typeof MCP_SERVER_VERSION;
  server: McpServerFilePayload;
}

/**
 * 解析社区服务器文件：信封 kind/version 校验 + 装入占位 id 借 validateMcpServerConfig
 * 逐字段校验负载（与手工录入同标准），全部失败抛 DW_MCP_SERVER_* 错误码。
 */
export function parseMcpServerFile(text: string): McpServerFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("DW_MCP_SERVER_INVALID_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("DW_MCP_SERVER_INVALID_JSON");
  const envelope = raw as Record<string, unknown>;
  if (envelope["kind"] !== MCP_SERVER_KIND) throw new Error("DW_MCP_SERVER_NOT_A_DEVWIT_SERVER");
  if (envelope["version"] !== MCP_SERVER_VERSION) {
    throw new Error(`DW_MCP_SERVER_UNSUPPORTED_VERSION:${String(envelope["version"])}`);
  }
  if (typeof envelope["server"] !== "object" || envelope["server"] === null || Array.isArray(envelope["server"])) {
    throw new Error("DW_MCP_SERVER_INVALID_SCHEMA:server must be an object");
  }
  // 借用配置校验：装入占位 id（此处只验负载字段，id 由导入方重建）
  const candidate = { id: "import-candidate", ...(envelope["server"] as object) } as McpServerConfig;
  try {
    validateMcpServerConfig(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DW_MCP_SERVER_INVALID_SCHEMA:${detail}`);
  }
  return envelope as unknown as McpServerFile;
}

/** 拉取单个社区服务器文件并校验（信封 + 配置同标准）。 */
export async function fetchCommunityMcpServer(
  base: string,
  file: string,
  fetchImpl: CommunityFetchLike
): Promise<McpServerFile> {
  assertSafeRelativeFile(file);
  return parseMcpServerFile(await fetchText(`${base}/${file}`, fetchImpl));
}

export interface MaterializeMcpImportOptions {
  /** 已存在的服务器 id——生成的 id 必须避开。 */
  existingIds: ReadonlySet<string>;
  /** id 生成器（默认 mcp-<base36 时间戳>，冲突时追加 -2/-3…）。 */
  makeId?: () => string;
}

/** 社区文件负载 → 本机服务器配置：新唯一 id，负载字段透传（已经过同标准校验）。 */
export function materializeMcpImport(file: McpServerFile, opts: MaterializeMcpImportOptions): McpServerConfig {
  const makeId = opts.makeId ?? (() => `mcp-${Date.now().toString(36)}`);
  let id = makeId();
  for (let n = 2; opts.existingIds.has(id); n += 1) {
    id = `${makeId()}-${n}`;
  }
  const payload = file.server;
  return {
    id,
    name: payload.name,
    command: payload.command,
    args: [...payload.args],
    ...(payload.env !== undefined ? { env: { ...payload.env } } : {}),
    enabled: payload.enabled,
  };
}
