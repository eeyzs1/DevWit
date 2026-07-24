import type { ContextItemType, ModeDefinition } from "@devwit/contracts";
import { validateModeDefinition } from "./mode-store.js";

/**
 * 模式导出/导入文件格式（迭代 14 / AC23：无账号的社区分享方式）。
 *
 * 设计要点：
 * - 信封带 kind/version，未来格式演进可识别旧文件并明确拒绝（不静默错读）；
 * - 导出剥离机器本地字段：id（导入方重新生成，避免与他人模式冲突）、
 *   builtin（导入恒为自定义模式）、createdAt/updatedAt（导入方重新盖章）；
 * - providerId 保留（同机往返保真），导入时若本机不存在该 provider 则清空为
 *   未绑定（模式语义允许空 providerId=跟随当前选中模型，用户可在设置页重绑）；
 * - 全部校验错误抛 ASCII 错误码（DW_MODE_IMPORT_*），渲染端 localizeError 本地化。
 */

export const MODE_EXPORT_KIND = "devwit-mode";
export const MODE_EXPORT_VERSION = 1;

/** 导出文件中与机器无关的模式负载。 */
export interface ModeExportPayload {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  providerId: string;
  contextPolicy: Partial<Record<ContextItemType, boolean>>;
  orchestrate?: boolean;
}

export interface ModeExportFile {
  kind: typeof MODE_EXPORT_KIND;
  version: typeof MODE_EXPORT_VERSION;
  exportedAt: string;
  mode: ModeExportPayload;
}

/** 模式定义 → 导出信封（剥离 id/builtin/时间戳）。 */
export function toExportFile(mode: ModeDefinition, now = new Date().toISOString()): ModeExportFile {
  return {
    kind: MODE_EXPORT_KIND,
    version: MODE_EXPORT_VERSION,
    exportedAt: now,
    mode: {
      name: mode.name,
      description: mode.description,
      systemPrompt: mode.systemPrompt,
      tools: [...mode.tools],
      providerId: mode.providerId,
      contextPolicy: { ...mode.contextPolicy },
      ...(mode.orchestrate !== undefined ? { orchestrate: mode.orchestrate } : {}),
    },
  };
}

/**
 * 解析并校验导出文件文本。复用 validateModeDefinition 做负载校验
 * （装入完整定义借用其逐字段校验），全部失败抛 DW_MODE_IMPORT_* 错误码。
 */
export function parseExportFile(text: string): ModeExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("DW_MODE_IMPORT_INVALID_JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("DW_MODE_IMPORT_INVALID_JSON");
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope["kind"] !== MODE_EXPORT_KIND) {
    throw new Error("DW_MODE_IMPORT_NOT_A_DEVWIT_MODE");
  }
  if (envelope["version"] !== MODE_EXPORT_VERSION) {
    throw new Error(`DW_MODE_IMPORT_UNSUPPORTED_VERSION:${String(envelope["version"])}`);
  }
  // 借用模式定义校验：装入占位 id/时间戳（此处只验负载字段，id 由导入方重建）
  const candidate = {
    id: "import-candidate",
    builtin: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(envelope["mode"] as object),
  } as ModeDefinition;
  try {
    validateModeDefinition(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`DW_MODE_IMPORT_INVALID_SCHEMA:${detail}`);
  }
  return envelope as unknown as ModeExportFile;
}

export interface MaterializeImportOptions {
  /** 已存在的模式 id（含内置）——生成的 id 必须避开。 */
  existingIds: ReadonlySet<string>;
  /** 本机已配置的 provider id 集合；payload.providerId 不在其中时清空为未绑定。 */
  providerIds: ReadonlySet<string>;
  /** 导入盖章时间（createdAt=updatedAt）。 */
  now?: string;
  /** id 生成器（默认 mode-<base36 时间戳>，冲突时追加 -2/-3…）。 */
  makeId?: () => string;
}

/** 导出负载 → 本机自定义模式：新唯一 id + builtin=false + 未知 provider 清空。 */
export function materializeImport(file: ModeExportFile, opts: MaterializeImportOptions): ModeDefinition {
  const now = opts.now ?? new Date().toISOString();
  const makeId = opts.makeId ?? (() => `mode-${Date.now().toString(36)}`);
  let id = makeId();
  for (let n = 2; opts.existingIds.has(id); n += 1) {
    id = `${makeId()}-${n}`;
  }
  const payload = file.mode;
  return {
    id,
    name: payload.name,
    description: payload.description,
    systemPrompt: payload.systemPrompt,
    tools: [...payload.tools],
    providerId: opts.providerIds.has(payload.providerId) ? payload.providerId : "",
    contextPolicy: { ...payload.contextPolicy },
    ...(payload.orchestrate !== undefined ? { orchestrate: payload.orchestrate } : {}),
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}
