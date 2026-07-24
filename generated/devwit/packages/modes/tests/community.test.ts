import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  DEFAULT_MODES_INDEX_BASE,
  MODES_INDEX_KIND,
  fetchCommunityIndex,
  fetchCommunityMode,
  parseModesIndex,
  resolveModesIndexBase,
  type CommunityFetchLike,
} from "../src/community.js";

const VALID_INDEX = JSON.stringify({
  kind: MODES_INDEX_KIND,
  version: 1,
  updatedAt: "2026-07-24T00:00:00.000Z",
  modes: [
    {
      file: "modes/code-reviewer.json",
      name: "Code Reviewer",
      description: "只读审查",
      author: "eeyzs1",
      tags: ["review"],
    },
    {
      file: "modes/commit-scribe.json",
      name: "Commit Scribe",
      description: "提交信息",
      author: "eeyzs1",
    },
  ],
});

const VALID_MODE_FILE = JSON.stringify({
  kind: "devwit-mode",
  version: 1,
  exportedAt: "2026-07-24T00:00:00.000Z",
  mode: {
    name: "Code Reviewer",
    description: "只读审查",
    systemPrompt: "You review code.",
    tools: ["read", "grep"],
    providerId: "",
    contextPolicy: {},
  },
});

/** 假 fetch：按 URL 路由到固定响应，记录请求序列。 */
function fakeFetch(routes: Record<string, { status: number; body: string }>): {
  fetchImpl: CommunityFetchLike;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl: CommunityFetchLike = async (url) => {
    requested.push(url);
    const hit = routes[url];
    if (hit === undefined) return { ok: false, status: 404, text: async () => "not found" };
    return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => hit.body };
  };
  return { fetchImpl, requested };
}

describe("resolveModesIndexBase", () => {
  it("缺省官方仓库；env 覆盖并归一尾斜杠；空串回落缺省", () => {
    assert.equal(resolveModesIndexBase({}), DEFAULT_MODES_INDEX_BASE);
    assert.equal(resolveModesIndexBase({ DEVWIT_MODES_INDEX_URL: "http://127.0.0.1:9/x/" }), "http://127.0.0.1:9/x");
    assert.equal(resolveModesIndexBase({ DEVWIT_MODES_INDEX_URL: "  " }), DEFAULT_MODES_INDEX_BASE);
  });
});

describe("parseModesIndex", () => {
  it("合法索引：逐条解析，tags 缺省归 []，空白修剪", () => {
    const entries = parseModesIndex(VALID_INDEX);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      file: "modes/code-reviewer.json",
      name: "Code Reviewer",
      description: "只读审查",
      author: "eeyzs1",
      tags: ["review"],
    });
    assert.deepEqual(entries[1]?.tags, []);
  });

  it("非 JSON / kind 不匹配 / 版本不支持 / modes 非数组 → 各自错误码", () => {
    assert.throws(() => parseModesIndex("not json"), /DW_MODES_INDEX_INVALID_JSON/);
    assert.throws(() => parseModesIndex(JSON.stringify({ kind: "other", version: 1, modes: [] })), /DW_MODES_INDEX_NOT_AN_INDEX/);
    assert.throws(
      () => parseModesIndex(JSON.stringify({ kind: MODES_INDEX_KIND, version: 2, modes: [] })),
      /DW_MODES_INDEX_UNSUPPORTED_VERSION:2/
    );
    assert.throws(
      () => parseModesIndex(JSON.stringify({ kind: MODES_INDEX_KIND, version: 1, modes: {} })),
      /DW_MODES_INDEX_INVALID_SCHEMA/
    );
  });

  it("条目缺必填字段 / tags 含非字符串 → INVALID_SCHEMA", () => {
    const base = { kind: MODES_INDEX_KIND, version: 1 };
    assert.throws(
      () => parseModesIndex(JSON.stringify({ ...base, modes: [{ file: "a.json", name: "A" }] })),
      /DW_MODES_INDEX_INVALID_SCHEMA/
    );
    assert.throws(
      () =>
        parseModesIndex(
          JSON.stringify({ ...base, modes: [{ file: "a.json", name: "A", description: "d", author: "x", tags: [1] }] })
        ),
      /DW_MODES_INDEX_INVALID_SCHEMA/
    );
  });

  it("条目 file 路径穿越（.. / 绝对路径 / 盘符）→ INVALID_SCHEMA", () => {
    const base = { kind: MODES_INDEX_KIND, version: 1 };
    for (const file of ["../evil.json", "/abs.json", "C:\\evil.json"]) {
      assert.throws(
        () =>
          parseModesIndex(JSON.stringify({ ...base, modes: [{ file, name: "A", description: "d", author: "x" }] })),
        /DW_MODES_INDEX_INVALID_SCHEMA/
      );
    }
  });
});

describe("fetchCommunityIndex", () => {
  it("GET <base>/index.json 并解析", async () => {
    const { fetchImpl, requested } = fakeFetch({ "http://local/index.json": { status: 200, body: VALID_INDEX } });
    const entries = await fetchCommunityIndex("http://local", fetchImpl);
    assert.deepEqual(requested, ["http://local/index.json"]);
    assert.equal(entries.length, 2);
  });

  it("HTTP 非 2xx → DW_MODES_INDEX_HTTP:<status>；网络异常 → DW_MODES_INDEX_UNREACHABLE", async () => {
    const down = fakeFetch({ "http://local/index.json": { status: 503, body: "x" } });
    await assert.rejects(() => fetchCommunityIndex("http://local", down.fetchImpl), /DW_MODES_INDEX_HTTP:503/);
    const boom: CommunityFetchLike = async () => {
      throw new Error("socket hangup");
    };
    await assert.rejects(() => fetchCommunityIndex("http://local", boom), /DW_MODES_INDEX_UNREACHABLE/);
  });
});

describe("fetchCommunityMode", () => {
  it("GET <base>/<file> 并复用 AC23 校验管线返回模式信封", async () => {
    const { fetchImpl, requested } = fakeFetch({
      "http://local/modes/code-reviewer.json": { status: 200, body: VALID_MODE_FILE },
    });
    const file = await fetchCommunityMode("http://local", "modes/code-reviewer.json", fetchImpl);
    assert.deepEqual(requested, ["http://local/modes/code-reviewer.json"]);
    assert.equal(file.kind, "devwit-mode");
    assert.equal(file.mode.name, "Code Reviewer");
  });

  it("模式文件校验失败透传 DW_MODE_IMPORT_*；file 路径穿越拒绝", async () => {
    const { fetchImpl } = fakeFetch({ "http://local/modes/bad.json": { status: 200, body: "{}" } });
    await assert.rejects(
      () => fetchCommunityMode("http://local", "modes/bad.json", fetchImpl),
      /DW_MODE_IMPORT_NOT_A_DEVWIT_MODE/
    );
    await assert.rejects(() => fetchCommunityMode("http://local", "../evil.json", fetchImpl), /DW_MODES_INDEX_INVALID_SCHEMA/);
  });
});
