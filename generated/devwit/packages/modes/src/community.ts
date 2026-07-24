/**
 * 社区模式索引客户端（迭代 16 / AC25：零账号社区分享）。
 *
 * 索引与模式文件托管在公开 Git 仓库（默认 eeyzs1/devwit-modes 的 main 分支
 * raw 地址）；主进程经本模块拉取索引与单个模式文件。模式文件解析复用
 * AC23 的 parseExportFile 校验管线——社区模式与文件导入同一标准。
 *
 * base URL 可注入（env DEVWIT_MODES_INDEX_URL 覆盖）：e2e 用本地 server，
 * 生产缺省官方仓库。全部失败抛 ASCII 错误码（DW_MODES_INDEX_*）。
 */
import type { CommunityModeEntry } from "@devwit/contracts";
import { parseExportFile, type ModeExportFile } from "./mode-port.js";

export const MODES_INDEX_KIND = "devwit-modes-index";
export const MODES_INDEX_VERSION = 1;
export const DEFAULT_MODES_INDEX_BASE = "https://raw.githubusercontent.com/eeyzs1/devwit-modes/main";

/** fetch 的最小结构依赖（Node 20 全局 fetch 天然满足）。 */
export interface CommunityFetchLike {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

type EnvLike = Record<string, string | undefined>;

/** 索引 base URL：env 覆盖优先（e2e 注入本地 server），缺省官方仓库；尾斜杠归一。 */
export function resolveModesIndexBase(env: EnvLike = process.env): string {
  const override = env["DEVWIT_MODES_INDEX_URL"];
  return typeof override === "string" && override.trim() !== ""
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_MODES_INDEX_BASE;
}

async function fetchText(url: string, fetchImpl: CommunityFetchLike): Promise<string> {
  let res: { ok: boolean; status: number; text(): Promise<string> };
  try {
    res = await fetchImpl(url);
  } catch {
    throw new Error("DW_MODES_INDEX_UNREACHABLE");
  }
  if (!res.ok) throw new Error(`DW_MODES_INDEX_HTTP:${String(res.status)}`);
  return res.text();
}

/** 索引条目 file 字段防路径穿越：拼接 base URL 前拒绝绝对路径与 ..。 */
function assertSafeRelativeFile(file: string): void {
  if (file === "" || file.startsWith("/") || file.includes("..") || /^[a-zA-Z]:[\\/]/.test(file)) {
    throw new Error("DW_MODES_INDEX_INVALID_SCHEMA");
  }
}

function readEntry(raw: unknown): CommunityModeEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("DW_MODES_INDEX_INVALID_SCHEMA");
  const entry = raw as Record<string, unknown>;
  for (const field of ["file", "name", "description", "author"] as const) {
    if (typeof entry[field] !== "string" || (entry[field] as string).trim() === "") {
      throw new Error("DW_MODES_INDEX_INVALID_SCHEMA");
    }
  }
  const tags = entry["tags"];
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw new Error("DW_MODES_INDEX_INVALID_SCHEMA");
  }
  const file = (entry["file"] as string).trim();
  assertSafeRelativeFile(file);
  return {
    file,
    name: (entry["name"] as string).trim(),
    description: entry["description"] as string,
    author: (entry["author"] as string).trim(),
    tags: tags === undefined ? [] : (tags as string[]),
  };
}

/** 解析索引文本：信封 kind/version 校验 + 逐条目 schema 校验。 */
export function parseModesIndex(text: string): CommunityModeEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("DW_MODES_INDEX_INVALID_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("DW_MODES_INDEX_INVALID_JSON");
  const index = raw as Record<string, unknown>;
  if (index["kind"] !== MODES_INDEX_KIND) throw new Error("DW_MODES_INDEX_NOT_AN_INDEX");
  if (index["version"] !== MODES_INDEX_VERSION) {
    throw new Error(`DW_MODES_INDEX_UNSUPPORTED_VERSION:${String(index["version"])}`);
  }
  const modes = index["modes"];
  if (!Array.isArray(modes)) throw new Error("DW_MODES_INDEX_INVALID_SCHEMA");
  return modes.map(readEntry);
}

/** 拉取索引：GET <base>/index.json。 */
export async function fetchCommunityIndex(base: string, fetchImpl: CommunityFetchLike): Promise<CommunityModeEntry[]> {
  return parseModesIndex(await fetchText(`${base}/index.json`, fetchImpl));
}

/** 拉取单个社区模式文件并校验（复用 AC23 parseExportFile 同标准）。 */
export async function fetchCommunityMode(
  base: string,
  file: string,
  fetchImpl: CommunityFetchLike
): Promise<ModeExportFile> {
  assertSafeRelativeFile(file);
  return parseExportFile(await fetchText(`${base}/${file}`, fetchImpl));
}
