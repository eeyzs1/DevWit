/**
 * SessionMetaStore 真实文件系统回环测试（迭代 28 / AC37）。
 *
 * 不用 mock：真实 tmp 目录 sessions.json 落盘，验证「改名/删除标记 → 新实例读回」
 * 与损坏文件容忍（元数据丢失最坏结果是改名失效，绝不阻断启动）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetaStore } from "../src/main/session-meta-store.js";

let tmpRoot = "";
let file = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-ac37-"));
  file = path.join(tmpRoot, "sessions.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SessionMetaStore（AC37 会话元数据）", () => {
  it("改名落盘并被新实例读回；空标题清除改名", () => {
    const store = new SessionMetaStore(file);
    store.rename("session-1", "重构登录页");
    expect(store.get("session-1").title).toBe("重构登录页");

    // 落盘证据：整体 JSON（version + sessions 表），非追加
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as { version: number; sessions: Record<string, { title?: string }> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.sessions["session-1"]?.title).toBe("重构登录页");

    // 新实例（模拟重启）读回
    expect(new SessionMetaStore(file).get("session-1").title).toBe("重构登录页");

    // 空标题 = 清除改名（回退首条用户消息预览）
    store.rename("session-1", "   ");
    expect(new SessionMetaStore(file).get("session-1").title).toBeUndefined();
  });

  it("markDeleted 标记且与改名共存；isDeleted 仅认显式 true", () => {
    const store = new SessionMetaStore(file);
    store.rename("session-1", "标题");
    store.markDeleted("session-1");
    const restored = new SessionMetaStore(file);
    expect(restored.isDeleted("session-1")).toBe(true);
    expect(restored.get("session-1").title).toBe("标题"); // 改名不因删除标记丢失
    expect(restored.isDeleted("session-2")).toBe(false); // 未知会话非删除态
  });

  it("损坏文件按空表启动（不抛异常），后续写入自愈", () => {
    writeFileSync(file, "{broken json\n", "utf-8");
    const store = new SessionMetaStore(file);
    expect(store.get("session-1")).toEqual({});
    expect(store.isDeleted("session-1")).toBe(false);
    store.rename("session-1", "自愈");
    expect(new SessionMetaStore(file).get("session-1").title).toBe("自愈");
  });

  it("非法字段被清洗：非字符串 title 与 非 true deleted 不生效", () => {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: {
          "session-1": { title: 123, deleted: "yes" },
          "session-2": "garbage",
          "session-3": { title: "  有效  " },
        },
      }),
      "utf-8"
    );
    const store = new SessionMetaStore(file);
    expect(store.get("session-1")).toEqual({});
    expect(store.get("session-2")).toEqual({});
    expect(store.get("session-3").title).toBe("  有效  ");
  });
});
