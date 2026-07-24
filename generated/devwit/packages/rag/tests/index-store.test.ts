import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexStore, type PersistedIndex } from "../src/index-store.js";

function sampleIndex(): PersistedIndex {
  return {
    chunks: [
      {
        id: "abc123",
        relPath: "src/a.ts",
        startLine: 1,
        endLine: 5,
        text: "const a = 1;",
        vector: [0.1, 0.2, 0.3],
      },
    ],
    files: { "src/a.ts": { mtimeMs: 1000, size: 12 } },
  };
}

describe("IndexStore", () => {
  let dir: string;
  let store: IndexStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-rag-store-"));
    store = new IndexStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("无历史索引时 load 返回 null", async () => {
    expect(await store.load()).toBeNull();
  });

  it("save → load 往返（块向量与文件元数据一致）", async () => {
    const index = sampleIndex();
    await store.save(index);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.chunks).toHaveLength(1);
    expect(loaded!.chunks[0]!.id).toBe("abc123");
    expect(loaded!.chunks[0]!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(loaded!.files["src/a.ts"]).toEqual({ mtimeMs: 1000, size: 12 });
  });

  it("空索引 save → load 返回空块空文件表（非 null）", async () => {
    await store.save({ chunks: [], files: {} });
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.chunks).toEqual([]);
    expect(loaded!.files).toEqual({});
  });

  it("files.json 损坏 → load 返回 null（触发全量重建）", async () => {
    await store.save(sampleIndex());
    fs.writeFileSync(path.join(dir, "files.json"), "{broken json", "utf-8");
    expect(await store.load()).toBeNull();
  });

  it("chunks.jsonl 单行损坏跳过，其余行正常加载", async () => {
    await store.save(sampleIndex());
    const chunksPath = path.join(dir, "chunks.jsonl");
    const raw = fs.readFileSync(chunksPath, "utf-8");
    fs.writeFileSync(chunksPath, `${raw}{bad line}\n`, "utf-8");
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.chunks).toHaveLength(1);
  });
});
