import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeProvider } from "../src/probe.js";

/**
 * 连接探测（AC26）真实 HTTP 回环：起本地服务断言端点路径、鉴权头、
 * 型号清单解析与全部 DW_PROBE_* 错误码路径（无网络 mock）。
 * probe 端点固定为 openai={baseUrl}/models、anthropic={baseUrl}/v1/models，
 * 各测试场景以 baseUrl 路径前缀区分。
 */

interface LastRequest {
  path: string;
  authorization?: string;
  apiKey?: string;
  anthropicVersion?: string;
}

describe("probeProvider 真实 HTTP 回环", () => {
  let server: Server;
  let port: number;
  let last: LastRequest;

  function handler(req: IncomingMessage, res: ServerResponse): void {
    last = {
      path: req.url ?? "",
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
      anthropicVersion: req.headers["anthropic-version"] as string | undefined,
    };
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "qwen3:8b" }, { id: "llama3.1:8b" }, { noId: true }, "junk", { id: "" }],
        })
      );
      return;
    }
    if (req.url === "/anthropic/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-5", type: "model" }, { id: "claude-haiku-4-5" }] }));
      return;
    }
    if (req.url === "/badkey/v1/models") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (req.url === "/empty/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list" }));
      return;
    }
    if (req.url === "/hang/v1/models") {
      // 永不响应：超时路径
      return;
    }
    res.writeHead(404);
    res.end();
  }

  beforeAll(async () => {
    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("openai：GET {baseUrl}/models，解析型号清单并过滤非法条目", async () => {
    const result = await probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(port)}/v1` });
    expect(last.path).toBe("/v1/models");
    expect(last.authorization).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["qwen3:8b", "llama3.1:8b"]);
  });

  it("openai：apiKey 存在时发送 authorization: Bearer 头", async () => {
    await probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: "sk-probe" });
    expect(last.authorization).toBe("Bearer sk-probe");
  });

  it("anthropic：GET {baseUrl}/v1/models（baseUrl 为 host 根），x-api-key + anthropic-version 头", async () => {
    const result = await probeProvider({
      type: "anthropic",
      baseUrl: `http://127.0.0.1:${String(port)}/anthropic`,
      apiKey: "sk-ant",
    });
    expect(last.path).toBe("/anthropic/v1/models");
    expect(last.apiKey).toBe("sk-ant");
    expect(last.anthropicVersion).toBe("2023-06-01");
    expect(result.models).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
  });

  it("服务器无 data 数组：仍算可达，models 为空", async () => {
    const result = await probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(port)}/empty/v1` });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([]);
  });

  it("HTTP 401：抛 DW_PROBE_HTTP:401", async () => {
    await expect(
      probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(port)}/badkey/v1`, apiKey: "bad" })
    ).rejects.toThrowError("DW_PROBE_HTTP:401");
  });

  it("连接拒绝：抛 DW_PROBE_UNREACHABLE", async () => {
    // 主动关一个临时服务器拿到确定未监听的端口
    const tmp = createServer();
    await new Promise<void>((resolve) => {
      tmp.listen(0, "127.0.0.1", resolve);
    });
    const deadPort = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      tmp.close(() => resolve());
    });
    await expect(probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(deadPort)}/v1` })).rejects.toThrowError(
      "DW_PROBE_UNREACHABLE"
    );
  });

  it("超时：抛 DW_PROBE_TIMEOUT:<ms>", async () => {
    await expect(
      probeProvider({ type: "openai", baseUrl: `http://127.0.0.1:${String(port)}/hang/v1`, timeoutMs: 150 })
    ).rejects.toThrowError("DW_PROBE_TIMEOUT:150");
  });

  it("非法 baseUrl：抛 DW_PROBE_INVALID_URL", async () => {
    await expect(probeProvider({ type: "openai", baseUrl: "not a url" })).rejects.toThrowError("DW_PROBE_INVALID_URL");
    await expect(probeProvider({ type: "openai", baseUrl: "  " })).rejects.toThrowError("DW_PROBE_INVALID_URL:empty");
  });
});
