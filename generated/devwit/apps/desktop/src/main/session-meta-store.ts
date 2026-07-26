/**
 * 对话会话元数据存储（迭代 28 / AC37）：多会话管理的改名/删除标记。
 *
 * - 落盘 userData/sessions.json（整体 JSON，非追加——元数据体量小且需随机改写）；
 * - 轨迹事件仍是会话内容的事实源（traces/*.jsonl），本存储只承载用户态 overlay：
 *   title（改名优先于首条用户消息预览）与 deleted（删除标记，列表过滤）；
 * - 文件损坏时按空表启动（元数据丢失最坏结果是改名失效，绝不阻断启动）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SessionMeta {
  title?: string;
  deleted?: boolean;
}

interface SessionMetaFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

function sanitizeMeta(raw: unknown): SessionMeta {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const out: SessionMeta = {};
  if (typeof record["title"] === "string" && record["title"].trim() !== "") out.title = record["title"];
  if (record["deleted"] === true) out.deleted = true;
  return out;
}

export class SessionMetaStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(sessionId: string): SessionMeta {
    return { ...this.readAll()[sessionId] };
  }

  isDeleted(sessionId: string): boolean {
    return this.readAll()[sessionId]?.deleted === true;
  }

  /** 改名（空标题等价清除改名，回退首条用户消息预览）。 */
  rename(sessionId: string, title: string): void {
    const all = this.readAll();
    const meta = all[sessionId] ?? {};
    const trimmed = title.trim();
    if (trimmed === "") delete meta.title;
    else meta.title = trimmed;
    all[sessionId] = meta;
    this.writeAll(all);
  }

  markDeleted(sessionId: string): void {
    const all = this.readAll();
    all[sessionId] = { ...all[sessionId], deleted: true };
    this.writeAll(all);
  }

  private readAll(): Record<string, SessionMeta> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as SessionMetaFile;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.sessions !== "object" || parsed.sessions === null) {
        return {};
      }
      const out: Record<string, SessionMeta> = {};
      for (const [id, meta] of Object.entries(parsed.sessions)) {
        out[id] = sanitizeMeta(meta);
      }
      return out;
    } catch {
      return {}; // 损坏文件按空表（审计原则：元数据可重建，不拖垮启动）
    }
  }

  private writeAll(sessions: Record<string, SessionMeta>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload: SessionMetaFile = { version: 1, sessions };
    writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  }
}
