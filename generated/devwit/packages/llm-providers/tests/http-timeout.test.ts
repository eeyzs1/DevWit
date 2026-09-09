/**
 * fetchWithConnectTimeout 真实集成测试（🟡修复回归：streamChat/embed 原先无超时）。
 * 用 node:http 起真实本地服务器（非 mock）验证两条关键语义：
 * 1) 服务器接受连接但永不回响应头 → 连接阶段超时拒绝（不再永久挂起）；
 * 2) 响应头及时到达 → 计时清除，流式体可以慢于超时窗口继续到达（长流合法）。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderHttpError } from "@devwit/contracts";
import { fetchWithConnectTimeout, fetchWithRetry } from "../src/http.js";

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections?.();
  }
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        resolve("http://127.0.0.1:1");
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("fetchWithConnectTimeout", () => {
  it("服务器不回响应头：连接阶段超时拒绝（DOMException TimeoutError 语义）", async () => {
    const server = http.createServer(() => {
      // 收到请求但永不写响应——模拟挂起的服务端
    });
    servers.push(server);
    const url = await listen(server);
    await expect(fetchWithConnectTimeout(url, { method: "POST" }, 300)).rejects.toThrow(/timeout|aborted/i);
  });

  it("响应头及时到达：超时计时清除，慢速流式体仍可完整读取（长流不受连接超时约束）", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // 头已发；体分两段、间隔超过超时窗口
      res.write("part1");
      setTimeout(() => {
        res.write("-part2");
        res.end();
      }, 600);
    });
    servers.push(server);
    const url = await listen(server);
    const response = await fetchWithConnectTimeout(url, { method: "GET" }, 300);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("part1-part2");
  });

  it("调用方 signal 在流式阶段中止：body 读取即刻中断", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("forever");
      req.on("close", () => res.end());
    });
    servers.push(server);
    const url = await listen(server);
    const controller = new AbortController();
    const response = await fetchWithConnectTimeout(url, { method: "GET", signal: controller.signal }, 30_000);
    expect(response.status).toBe(200);
    controller.abort();
    await expect(response.text()).rejects.toThrow();
  });
});

describe("fetchWithRetry（🟡修复回归：429/5xx 预流重试——retryable 此前无消费方）", () => {
  it("429 后 200：重试成功，服务端共收到 2 次请求（Retry-After 尊重）", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(429, { "retry-after": "0.05" }); // 50ms，测试加速
        res.end("rate limited");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    servers.push(server);
    const url = await listen(server);
    const response = await fetchWithRetry(url, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("持续 500：2 次重试后抛 ProviderHttpError(status=500)，共 3 次尝试", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts += 1;
      res.writeHead(500);
      res.end("boom");
    });
    servers.push(server);
    const url = await listen(server);
    await expect(fetchWithRetry(url, { method: "POST" }, { retries: 2 })).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 500,
    });
    expect(attempts).toBe(3);
  });

  it("404 不可重试：单次尝试即抛", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts += 1;
      res.writeHead(404);
      res.end("nope");
    });
    servers.push(server);
    const url = await listen(server);
    await expect(fetchWithRetry(url, { method: "POST" })).rejects.toBeInstanceOf(ProviderHttpError);
    expect(attempts).toBe(1);
  });

  it("退避等待期间调用方 abort：立即中断不再重试", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts += 1;
      res.writeHead(429, { "retry-after": "60" }); // 60s 退避窗口
      res.end("slow down");
    });
    servers.push(server);
    const url = await listen(server);
    const controller = new AbortController();
    const pending = fetchWithRetry(url, { method: "POST", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
