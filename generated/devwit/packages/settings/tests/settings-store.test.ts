import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialNotFoundError } from "@devwit/contracts";
import { NodeCryptoBackend } from "../src/node-crypto-backend.js";
import { SettingsStore } from "../src/settings-store.js";

const SECRET = "test-secret-value-0123456789abcdef";

describe("NodeCryptoBackend", () => {
  it("AES-256-GCM 加解密往返", () => {
    const crypto = new NodeCryptoBackend();
    expect(crypto.name).toBe("node-crypto");
    const ciphertext = crypto.encryptString(SECRET);
    expect(ciphertext).not.toBe(SECRET);
    expect(ciphertext).not.toContain(SECRET);
    expect(crypto.decryptString(ciphertext)).toBe(SECRET);
  });

  it("同一明文两次加密结果不同（随机 IV）", () => {
    const crypto = new NodeCryptoBackend();
    expect(crypto.encryptString(SECRET)).not.toBe(crypto.encryptString(SECRET));
  });
});

describe("SettingsStore", () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-settings-"));
    store = new SettingsStore(new NodeCryptoBackend(), dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("set/get 往返并持久化到 settings.json", () => {
    store.set("theme", "dark");
    expect(store.get("theme")).toBe("dark");
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8")) as Record<string, unknown>;
    expect(raw["theme"]).toBe("dark");
  });

  it("set 触发 onChanged 监听器（热更新）", () => {
    const events: Array<[string, unknown]> = [];
    const off = store.onChanged((key, value) => {
      events.push([key, value]);
    });
    store.set("fontSize", 14);
    expect(events).toEqual([["fontSize", 14]]);
    off();
    store.set("fontSize", 16);
    expect(events).toHaveLength(1);
  });

  it("凭证加密落盘：文件不含明文，resolve 契约可读回", async () => {
    store.setCredential("anthropic/default", "anthropic", SECRET);
    const rawOnDisk = fs.readFileSync(path.join(dir, "credentials.enc.json"), "utf-8");
    expect(rawOnDisk).not.toContain(SECRET);
    // CredentialResolver 契约
    const resolved = await store.resolve("anthropic/default");
    expect(resolved).toBe(SECRET);
    expect(store.getCredential("anthropic/default")).toBe(SECRET);
  });

  it("listCredentials 只含元信息", () => {
    store.setCredential("openai/default", "openai", SECRET);
    const list = store.listCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]?.ref).toBe("openai/default");
    expect(list[0]?.provider).toBe("openai");
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["createdAt", "provider", "ref", "updatedAt"]);
  });

  it("缺失 ref 抛 CredentialNotFoundError", async () => {
    expect(() => store.getCredential("missing")).toThrow(CredentialNotFoundError);
    await expect(store.resolve("missing")).rejects.toThrow(CredentialNotFoundError);
    expect(() => store.deleteCredential("missing")).toThrow(CredentialNotFoundError);
  });

  it("deleteCredential 后不可再读取", () => {
    store.setCredential("a", "p", SECRET);
    store.deleteCredential("a");
    expect(store.listCredentials()).toHaveLength(0);
    expect(() => store.getCredential("a")).toThrow(CredentialNotFoundError);
  });

  it("reload 从磁盘重读并对变化键触发监听", () => {
    const events: Array<[string, unknown]> = [];
    store.onChanged((key, value) => {
      events.push([key, value]);
    });
    // 模拟外部进程直接改文件
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ theme: "light", added: true }, null, 2),
      "utf-8"
    );
    store.reload();
    expect(store.get("theme")).toBe("light");
    expect(events).toContainEqual(["theme", "light"]);
    expect(events).toContainEqual(["added", true]);
  });

  it("新实例从磁盘恢复凭证（跨进程持久化）", async () => {
    store.setCredential("persist", "anthropic", SECRET);
    const store2 = new SettingsStore(new NodeCryptoBackend(), dir);
    await expect(store2.resolve("persist")).resolves.toBe(SECRET);
  });
});

describe("凭证损坏可见化（v0.7.2）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-settings-corrupt-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("凭据文件损坏：构造即备份原文件并持久化告警标记（不再静默清空）", () => {
    fs.writeFileSync(path.join(dir, "credentials.enc.json"), "{corrupted!!", "utf-8");
    const store = new SettingsStore(new NodeCryptoBackend(), dir);
    const marker = store.get("security.credentialsCorrupt") as { backupFile: string; detectedAt: string };
    expect(marker).toBeDefined();
    expect(marker.backupFile).toMatch(/^credentials\.enc\.json\.corrupt-\d+$/);
    expect(Number.isNaN(Date.parse(marker.detectedAt))).toBe(false);
    // 原文件已改名备份、目录中存在备份文件
    expect(fs.existsSync(path.join(dir, marker.backupFile))).toBe(true);
    // 标记持久化：新实例（settings.json 已带标记）仍可见
    const store2 = new SettingsStore(new NodeCryptoBackend(), dir);
    expect(store2.get("security.credentialsCorrupt")).toBeDefined();
  });

  it("用户重新录入凭证后清除标记并触发变更事件（横幅热消失）", () => {
    fs.writeFileSync(path.join(dir, "credentials.enc.json"), "{corrupted!!", "utf-8");
    const store = new SettingsStore(new NodeCryptoBackend(), dir);
    expect(store.get("security.credentialsCorrupt")).toBeDefined();
    const events: Array<[string, unknown]> = [];
    store.onChanged((key, value) => events.push([key, value]));
    store.setCredential("openai/default", "openai", SECRET);
    expect(store.get("security.credentialsCorrupt")).toBeUndefined();
    expect(events).toContainEqual(["security.credentialsCorrupt", undefined]);
    // 持久化清除：新实例不再看到标记
    const store2 = new SettingsStore(new NodeCryptoBackend(), dir);
    expect(store2.get("security.credentialsCorrupt")).toBeUndefined();
  });

  it("正常凭据文件不产生标记", () => {
    const store = new SettingsStore(new NodeCryptoBackend(), dir);
    store.setCredential("a", "p", SECRET);
    const store2 = new SettingsStore(new NodeCryptoBackend(), dir);
    expect(store2.get("security.credentialsCorrupt")).toBeUndefined();
  });
});
