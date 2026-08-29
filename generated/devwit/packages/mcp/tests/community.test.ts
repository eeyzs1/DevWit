import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  fetchCommunityMcpIndex,
  fetchCommunityMcpServer,
  materializeMcpImport,
  parseMcpIndex,
  parseMcpServerFile,
  type CommunityFetchLike,
} from "../src/community.js";

const VALID_INDEX = JSON.stringify({
  kind: "devwit-modes-index",
  version: 1,
  updatedAt: "2026-07-25T00:00:00.000Z",
  modes: [],
  mcpServers: [
    {
      file: "mcp/filesystem.json",
      name: "Filesystem",
      description: "工作区文件读写",
      author: "eeyzs1",
      tools: ["read_file", "write_file"],
    },
    {
      file: "mcp/fetch.json",
      name: "Fetch",
      description: "网页抓取",
      author: "eeyzs1",
    },
  ],
});

const VALID_SERVER_FILE = JSON.stringify({
  kind: "devwit-mcp-server",
  version: 1,
  server: {
    name: "Filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    env: { LOG_LEVEL: "info" },
    enabled: true,
  },
});

const HTTP_SERVER_FILE = JSON.stringify({
  kind: "devwit-mcp-server",
  version: 1,
  server: {
    name: "Remote",
    transport: "http",
    url: "https://remote.test/mcp",
    headers: { "X-Api-Key": "k" },
    enabled: true,
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

describe("parseMcpIndex（AC34 索引 mcpServers 段解析）", () => {
  it("合法索引：逐条目解析，tools 缺省回空数组", () => {
    const entries = parseMcpIndex(VALID_INDEX);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.file, "mcp/filesystem.json");
    assert.deepEqual(entries[0]!.tools, ["read_file", "write_file"]);
    assert.deepEqual(entries[1]!.tools, []);
  });

  it("mcpServers 段缺省 → 空数组（可选段向前兼容，旧索引不报锶）", () => {
    const entries = parseMcpIndex(JSON.stringify({ kind: "devwit-modes-index", version: 1, modes: [] }));
    assert.deepEqual(entries, []);
  });

  it("非 JSON / 非对象 → DW_MCP_INDEX_INVALID_JSON", () => {
    assert.throws(() => parseMcpIndex("not json"), /DW_MCP_INDEX_INVALID_JSON/);
    assert.throws(() => parseMcpIndex("[1]"), /DW_MCP_INDEX_INVALID_JSON/);
  });

  it("kind 不符 → DW_MCP_INDEX_NOT_AN_INDEX；version 不符 → UNSUPPORTED_VERSION", () => {
    assert.throws(() => parseMcpIndex(JSON.stringify({ kind: "other", version: 1 })), /DW_MCP_INDEX_NOT_AN_INDEX/);
    assert.throws(
      () => parseMcpIndex(JSON.stringify({ kind: "devwit-modes-index", version: 2 })),
      /DW_MCP_INDEX_UNSUPPORTED_VERSION:2/
    );
  });

  it("mcpServers 非数组 / 条目缺字段 → DW_MCP_INDEX_INVALID_SCHEMA", () => {
    assert.throws(
      () => parseMcpIndex(JSON.stringify({ kind: "devwit-modes-index", version: 1, mcpServers: "x" })),
      /DW_MCP_INDEX_INVALID_SCHEMA/
    );
    assert.throws(
      () =>
        parseMcpIndex(
          JSON.stringify({ kind: "devwit-modes-index", version: 1, mcpServers: [{ file: "mcp/a.json", name: "" }] })
        ),
      /DW_MCP_INDEX_INVALID_SCHEMA/
    );
  });

  it("条目 file 路径穿越 → 拒绝（绝对路径 / .. / 盘符）", () => {
    for (const file of ["/etc/passwd", "../escape.json", "C:\\win.json"]) {
      assert.throws(
        () =>
          parseMcpIndex(
            JSON.stringify({
              kind: "devwit-modes-index",
              version: 1,
              mcpServers: [{ file, name: "n", description: "d", author: "a" }],
            })
          ),
        /DW_MCP_INDEX_INVALID_SCHEMA/
      );
    }
  });
});

describe("parseMcpServerFile（AC34 服务器文件信封校验）", () => {
  it("合法文件：信封 + 负载全字段解析", () => {
    const file = parseMcpServerFile(VALID_SERVER_FILE);
    assert.equal(file.kind, "devwit-mcp-server");
    assert.equal(file.server.command, "npx");
    assert.deepEqual(file.server.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
    assert.equal(file.server.enabled, true);
  });

  it("非 JSON → INVALID_JSON；kind 不符 → NOT_A_DEVWIT_SERVER；version 不符 → UNSUPPORTED", () => {
    assert.throws(() => parseMcpServerFile("oops"), /DW_MCP_SERVER_INVALID_JSON/);
    assert.throws(() => parseMcpServerFile(JSON.stringify({ kind: "devwit-mode", version: 1 })), /DW_MCP_SERVER_NOT_A_DEVWIT_SERVER/);
    assert.throws(
      () => parseMcpServerFile(JSON.stringify({ kind: "devwit-mcp-server", version: 9, server: {} })),
      /DW_MCP_SERVER_UNSUPPORTED_VERSION:9/
    );
  });

  it("负载缺字段/脏字段 → INVALID_SCHEMA 带 detail（借 validateMcpServerConfig 同标准）", () => {
    assert.throws(
      () => parseMcpServerFile(JSON.stringify({ kind: "devwit-mcp-server", version: 1, server: { name: "x" } })),
      /DW_MCP_SERVER_INVALID_SCHEMA:.*command/
    );
    assert.throws(
      () =>
        parseMcpServerFile(
          JSON.stringify({
            kind: "devwit-mcp-server",
            version: 1,
            server: { name: "x", command: "npx", args: [1], enabled: true },
          })
        ),
      /DW_MCP_SERVER_INVALID_SCHEMA:.*args/
    );
    assert.throws(
      () =>
        parseMcpServerFile(
          JSON.stringify({
            kind: "devwit-mcp-server",
            version: 1,
            server: { name: "x", command: "npx", args: [], enabled: "yes" },
          })
        ),
      /DW_MCP_SERVER_INVALID_SCHEMA:.*enabled/
    );
  });

  it("合法远程（http）服务器文件：transport/url/headers 解析", () => {
    const file = parseMcpServerFile(HTTP_SERVER_FILE);
    assert.equal(file.server.transport, "http");
    assert.equal(file.server.url, "https://remote.test/mcp");
    assert.deepEqual(file.server.headers, { "X-Api-Key": "k" });
  });

  it("http 负载缺 url → INVALID_SCHEMA；设置 command 也被拒（transport 互斥）", () => {
    assert.throws(
      () =>
        parseMcpServerFile(
          JSON.stringify({ kind: "devwit-mcp-server", version: 1, server: { name: "R", transport: "http", enabled: true } })
        ),
      /DW_MCP_SERVER_INVALID_SCHEMA:.*url/
    );
    assert.throws(
      () =>
        parseMcpServerFile(
          JSON.stringify({ kind: "devwit-mcp-server", version: 1, server: { name: "R", transport: "http", url: "https://r/mcp", command: "npx", enabled: true } })
        ),
      /DW_MCP_SERVER_INVALID_SCHEMA:.*command/
    );
  });
});

describe("materializeMcpImport（AC34 落为本机配置）", () => {
  it("新 id 生成 + 冲突追加序号；负载字段透传", () => {
    const file = parseMcpServerFile(VALID_SERVER_FILE);
    const config = materializeMcpImport(file, { existingIds: new Set(["mcp-fixed"]), makeId: () => "mcp-fixed" });
    assert.equal(config.id, "mcp-fixed-2");
    assert.equal(config.name, "Filesystem");
    assert.deepEqual(config.env, { LOG_LEVEL: "info" });
    assert.equal(config.enabled, true);
  });

  it("无冲突用首 id；env 缺省不回填空对象", () => {
    const bare = JSON.stringify({
      kind: "devwit-mcp-server",
      version: 1,
      server: { name: "Fetch", command: "node", args: ["fetch.js"], enabled: false },
    });
    const config = materializeMcpImport(parseMcpServerFile(bare), { existingIds: new Set(), makeId: () => "mcp-a" });
    assert.equal(config.id, "mcp-a");
    assert.equal(config.env, undefined);
    assert.equal(config.enabled, false);
  });

  it("远程（http）负载透传：transport/url/headers 落为本机配置，command 不掺入", () => {
    const config = materializeMcpImport(parseMcpServerFile(HTTP_SERVER_FILE), { existingIds: new Set(), makeId: () => "mcp-r" });
    assert.equal(config.id, "mcp-r");
    assert.equal(config.transport, "http");
    assert.equal(config.url, "https://remote.test/mcp");
    assert.deepEqual(config.headers, { "X-Api-Key": "k" });
    assert.equal(config.command, undefined);
  });
});

describe("fetchCommunityMcpIndex / fetchCommunityMcpServer（AC34 拉取链路）", () => {
  it("索引 GET <base>/index.json；条目 GET <base>/<file>", async () => {
    const { fetchImpl, requested } = fakeFetch({
      "https://example.test/index.json": { status: 200, body: VALID_INDEX },
      "https://example.test/mcp/filesystem.json": { status: 200, body: VALID_SERVER_FILE },
    });
    const entries = await fetchCommunityMcpIndex("https://example.test", fetchImpl);
    assert.equal(entries.length, 2);
    const file = await fetchCommunityMcpServer("https://example.test", entries[0]!.file, fetchImpl);
    assert.equal(file.server.name, "Filesystem");
    assert.deepEqual(requested, ["https://example.test/index.json", "https://example.test/mcp/filesystem.json"]);
  });

  it("网络异常 → DW_MCP_INDEX_UNREACHABLE；HTTP 非 2xx → DW_MCP_INDEX_HTTP:<status>", async () => {
    const down: CommunityFetchLike = async () => {
      throw new Error("socket hangup");
    };
    await assert.rejects(() => fetchCommunityMcpIndex("https://example.test", down), /DW_MCP_INDEX_UNREACHABLE/);
    const { fetchImpl } = fakeFetch({ "https://example.test/index.json": { status: 503, body: "busy" } });
    await assert.rejects(() => fetchCommunityMcpIndex("https://example.test", fetchImpl), /DW_MCP_INDEX_HTTP:503/);
  });

  it("条目 file 路径穿越 → 拉取前拒绝", async () => {
    const { fetchImpl, requested } = fakeFetch({});
    await assert.rejects(() => fetchCommunityMcpServer("https://example.test", "../x.json", fetchImpl), /DW_MCP_INDEX_INVALID_SCHEMA/);
    assert.equal(requested.length, 0);
  });
});
