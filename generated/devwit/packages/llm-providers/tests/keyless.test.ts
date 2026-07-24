import type { CredentialResolver, ProviderConfig } from "@devwit/contracts";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatibleEmbedder } from "../src/embeddings.js";
import { OpenAiCompatibleProvider } from "../src/openai.js";
import { collect } from "./helpers.js";

/**
 * keyless（AC22）真实 HTTP 回环：起本地 OpenAI 兼容服务，
 * 断言免 key 配置不解析凭证、不发送 authorization 头，且协议帧完整解析。
 * 对照组（keyed）断言 authorization: Bearer 按原样送达。
 */

/** 被调用即抛错的凭证解析器：keyless 路径绝不应触碰凭证存储。 */
const forbiddenCredentials: CredentialResolver = {
  resolve: () => {
    throw new Error("credential store must not be touched for keyless provider");
  },
};

const staticCredentials: CredentialResolver = {
  resolve: async () => "sk-test-static",
};

function keylessConfig(port: number): ProviderConfig {
  return {
    id: "local",
    type: "openai",
    label: "Local",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "local-model",
    credentialRef: "cred-local",
    maxTokens: 512,
    keyless: true,
  };
}

function keyedConfig(port: number): ProviderConfig {
  return { ...keylessConfig(port), id: "remote", keyless: undefined };
}

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"pong"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
  "data: [DONE]",
  "",
].join("\n");

describe("keyless provider 真实 HTTP 回环", () => {
  let server: Server;
  let port: number;
  let lastAuth: string | undefined;
  let lastPath: string | undefined;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      lastAuth = req.headers.authorization;
      lastPath = req.url ?? "";
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE_BODY);
        return;
      }
      if (req.url === "/v1/embeddings") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], model: "embed-model" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
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

  it("streamChat：keyless 不解析凭证、请求无 authorization 头，SSE 事件完整解析", async () => {
    const provider = new OpenAiCompatibleProvider(keylessConfig(port), forbiddenCredentials);
    const events = await collect(provider.streamChat([{ role: "user", content: "ping" }], []));
    expect(lastPath).toBe("/v1/chat/completions");
    expect(lastAuth).toBeUndefined();
    expect(events).toEqual([
      { type: "text", text: "pong" },
      { type: "usage", inputTokens: 2, outputTokens: 1 },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("streamChat：keyed 对照组发送 authorization: Bearer 头", async () => {
    const provider = new OpenAiCompatibleProvider(keyedConfig(port), staticCredentials);
    await collect(provider.streamChat([{ role: "user", content: "ping" }], []));
    expect(lastAuth).toBe("Bearer sk-test-static");
  });

  it("embed：keyless 不解析凭证、无 authorization 头，向量按 index 对齐返回", async () => {
    const embedder = new OpenAiCompatibleEmbedder(keylessConfig(port), "embed-model", forbiddenCredentials);
    const vectors = await embedder.embed(["hello"]);
    expect(lastPath).toBe("/v1/embeddings");
    expect(lastAuth).toBeUndefined();
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("embed：keyed 对照组发送 authorization: Bearer 头", async () => {
    const embedder = new OpenAiCompatibleEmbedder(keyedConfig(port), "embed-model", staticCredentials);
    await embedder.embed(["hello"]);
    expect(lastAuth).toBe("Bearer sk-test-static");
  });
});
