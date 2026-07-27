/**
 * @devwit/i18n — 轻量界面国际化（迭代 3 / AC12）。
 *
 * - t(key, vars?)：查当前语言文案，{name} 占位符插值；未命中回落 zh-CN，再未命中返回 key 本身（开发期可发现漏配）；
 * - ta(key)：取数组型文案（如引导示例、对话空态说明行）；
 * - setLocale 触发 onDidChangeLocale——各视图订阅后重渲染，语言热生效（AC12），
 *   持久化由 apps 层负责（settings 键 "ui.locale"）。
 */
import { DICTIONARIES, type Locale, type MessageKey, type Messages } from "./messages.js";

export { LOCALES, LOCALE_LABEL, type Locale, type MessageKey } from "./messages.js";

type StringMessageKey = {
  [K in MessageKey]: Messages[K] extends string ? K : never;
}[MessageKey];
type ArrayMessageKey = {
  [K in MessageKey]: Messages[K] extends string[] ? K : never;
}[MessageKey];

let current: Locale = "zh-CN";
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** 系统语言探测（跟随系统选项）：中文环境用 zh-CN，其余一律回落 en-US。 */
export function resolveSystemLocale(): Locale {
  const lang = typeof navigator === "undefined" ? "" : navigator.language;
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener();
}

export function onDidChangeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 插值：把 {name} 替换为 vars[name]；vars 缺失的占位符原样保留（不静默吞掉配置错误）。 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const value = vars[name];
    return value === undefined ? raw : String(value);
  });
}

export function t(key: StringMessageKey, vars?: Record<string, string | number>): string {
  const table = DICTIONARIES[current];
  const value = table[key] ?? DICTIONARIES["zh-CN"][key];
  if (typeof value !== "string") return key;
  return interpolate(value, vars);
}

export function ta(key: ArrayMessageKey): string[] {
  const table = DICTIONARIES[current];
  const value = table[key] ?? DICTIONARIES["zh-CN"][key];
  return Array.isArray(value) ? [...value] : [];
}

// ---------------------------------------------------------------------------
// 内置模式显示名（迭代 4）：数据层工厂名为英文常量，界面按当前语言显示
// ---------------------------------------------------------------------------

const BUILTIN_MODE_FACTORY_NAME: Record<string, string> = { chat: "Chat", agent: "Agent", orchestrator: "Orchestrator" };
const BUILTIN_MODE_NAME_KEY: Record<string, StringMessageKey> = {
  chat: "mode.builtin.chat.name",
  agent: "mode.builtin.agent.name",
  orchestrator: "mode.builtin.orchestrator.name",
};

/** 内置模式显示名：工厂默认名按当前语言本地化；用户改名后尊重用户值。 */
export function displayModeName(mode: { id: string; name: string; builtin: boolean }): string {
  if (!mode.builtin) return mode.name;
  const key = BUILTIN_MODE_NAME_KEY[mode.id];
  if (key === undefined || mode.name !== BUILTIN_MODE_FACTORY_NAME[mode.id]) return mode.name;
  return t(key);
}

// ---------------------------------------------------------------------------
// 运行时错误本地化（迭代 4）：主进程抛 ASCII 错误码（DW_*），终端不再输出
// 中文（GBK 终端 stderr 乱码根因）；渲染端在此按当前语言映射回文案。
// ---------------------------------------------------------------------------

export interface LocalizeErrorOptions {
  /** 按 modeId 解析显示名（如 chat-panel 用 listModes + displayModeName）。 */
  resolveModeName?: (modeId: string) => string;
}

const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;

/** 错误码 → 当前语言文案；未命中已知码时剥掉 Electron IPC 前缀原样返回。 */
export function localizeError(raw: string, opts?: LocalizeErrorOptions): string {
  const unbound = /DW_MODE_UNBOUND:([\w-]+)/.exec(raw);
  if (unbound !== null) {
    const id = unbound[1] ?? "";
    return t("err.modeUnbound", { name: opts?.resolveModeName?.(id) ?? id });
  }
  const notFound = /DW_MODE_NOT_FOUND:([\w-]+)/.exec(raw);
  if (notFound !== null) return t("err.modeNotFound", { id: notFound[1] ?? "" });
  // 迭代 14 / AC23 模式导入错误码
  if (raw.includes("DW_MODE_IMPORT_INVALID_JSON")) return t("err.modeImportInvalidJson");
  if (raw.includes("DW_MODE_IMPORT_NOT_A_DEVWIT_MODE")) return t("err.modeImportNotDevwitMode");
  const importVersion = /DW_MODE_IMPORT_UNSUPPORTED_VERSION:([^\n]*)/.exec(raw);
  if (importVersion !== null) return t("err.modeImportVersion", { version: (importVersion[1] ?? "").trim() });
  const importSchema = /DW_MODE_IMPORT_INVALID_SCHEMA:([^\n]*)/.exec(raw);
  if (importSchema !== null) return t("err.modeImportSchema", { detail: (importSchema[1] ?? "").trim() });
  // 迭代 16 / AC25 社区模式索引错误码
  if (raw.includes("DW_MODES_INDEX_UNREACHABLE")) return t("err.modesIndexUnreachable");
  const indexHttp = /DW_MODES_INDEX_HTTP:(\d+)/.exec(raw);
  if (indexHttp !== null) return t("err.modesIndexHttp", { status: indexHttp[1] ?? "" });
  if (raw.includes("DW_MODES_INDEX_INVALID_JSON")) return t("err.modesIndexInvalidJson");
  if (raw.includes("DW_MODES_INDEX_NOT_AN_INDEX")) return t("err.modesIndexNotIndex");
  const indexVersion = /DW_MODES_INDEX_UNSUPPORTED_VERSION:([^\n]*)/.exec(raw);
  if (indexVersion !== null) return t("err.modesIndexVersion", { version: (indexVersion[1] ?? "").trim() });
  if (raw.includes("DW_MODES_INDEX_INVALID_SCHEMA")) return t("err.modesIndexSchema");
  // 迭代 25 / AC34 社区 MCP 索引 / 服务器文件错误码
  if (raw.includes("DW_MCP_INDEX_UNREACHABLE")) return t("err.mcpIndexUnreachable");
  const mcpIndexHttp = /DW_MCP_INDEX_HTTP:(\d+)/.exec(raw);
  if (mcpIndexHttp !== null) return t("err.mcpIndexHttp", { status: mcpIndexHttp[1] ?? "" });
  if (raw.includes("DW_MCP_INDEX_INVALID_JSON")) return t("err.mcpIndexInvalidJson");
  if (raw.includes("DW_MCP_INDEX_NOT_AN_INDEX")) return t("err.mcpIndexNotIndex");
  const mcpIndexVersion = /DW_MCP_INDEX_UNSUPPORTED_VERSION:([^\n]*)/.exec(raw);
  if (mcpIndexVersion !== null) return t("err.mcpIndexVersion", { version: (mcpIndexVersion[1] ?? "").trim() });
  if (raw.includes("DW_MCP_INDEX_INVALID_SCHEMA")) return t("err.mcpIndexSchema");
  if (raw.includes("DW_MCP_SERVER_INVALID_JSON")) return t("err.mcpServerInvalidJson");
  if (raw.includes("DW_MCP_SERVER_NOT_A_DEVWIT_SERVER")) return t("err.mcpServerNotDevwit");
  const mcpServerVersion = /DW_MCP_SERVER_UNSUPPORTED_VERSION:([^\n]*)/.exec(raw);
  if (mcpServerVersion !== null) return t("err.mcpServerVersion", { version: (mcpServerVersion[1] ?? "").trim() });
  const mcpServerSchema = /DW_MCP_SERVER_INVALID_SCHEMA:([^\n]*)/.exec(raw);
  if (mcpServerSchema !== null) return t("err.mcpServerSchema", { detail: (mcpServerSchema[1] ?? "").trim() });
  if (raw.includes("DW_SESSION_BUSY")) return t("chat.error.busy");
  if (raw.includes("DW_EXTERNAL_EDITOR_NOT_CONFIGURED")) return t("err.externalNotConfigured");
  if (raw.includes("DW_EXTERNAL_EDITOR_TEMPLATE_EMPTY")) return t("err.templateEmpty");
  if (raw.includes("DW_EXTERNAL_EDITOR_MISSING_FILE_PLACEHOLDER")) return t("err.missingFilePlaceholder");
  const spawn = /DW_EXTERNAL_EDITOR_SPAWN_FAILED:([^\n]*)/.exec(raw);
  if (spawn !== null) return t("err.spawnFailed", { detail: (spawn[1] ?? "").trim() });
  if (raw.includes("DW_AI_NOT_WIRED")) return t("err.aiNotWired");
  const sseParse = /DW_SSE_PARSE_FAILED:(\w+)/.exec(raw);
  if (sseParse !== null) return t("err.sseParseFailed", { provider: sseParse[1] ?? "" });
  const llmUnknown = /DW_LLM_ERROR:(\w+)/.exec(raw);
  if (llmUnknown !== null) return t("err.llmUnknown", { provider: llmUnknown[1] ?? "" });
  // 迭代 17 / AC26 连接探测错误码
  const probeTimeout = /DW_PROBE_TIMEOUT(?::(\d+))?/.exec(raw);
  if (probeTimeout !== null) return t("err.probeTimeout", { ms: probeTimeout[1] ?? "5000" });
  const probeHttp = /DW_PROBE_HTTP:(\d+)/.exec(raw);
  if (probeHttp !== null) return t("err.probeHttp", { status: probeHttp[1] ?? "" });
  if (raw.includes("DW_PROBE_UNREACHABLE")) return t("err.probeUnreachable");
  if (raw.includes("DW_PROBE_INVALID_URL")) return t("err.probeInvalidUrl");
  // 迭代 32 / AC41 Git 版本控制错误码（detail 为 git stderr 摘要，随码剥离不展示）
  if (raw.includes("DW_GIT_NOT_REPO")) return t("err.gitNotRepo");
  if (raw.includes("DW_GIT_STAGE_FAILED")) return t("err.gitStageFailed");
  if (raw.includes("DW_GIT_UNSTAGE_FAILED")) return t("err.gitUnstageFailed");
  if (raw.includes("DW_GIT_COMMIT_FAILED")) return t("err.gitCommitFailed");
  if (raw.includes("DW_GIT_NOT_WIRED")) return t("err.gitNotWired");
  return raw.replace(IPC_ERROR_PREFIX, "");
}
