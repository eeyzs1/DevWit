/**
 * js-debug TCP 传输（迭代 33 / AC42）：dapDebugServer.js 只讲 TCP 不讲 stdio——
 * spawn 后 stdout 打一行 "Debug server listening at <host>:<port>"，
 * 客户端再 net.connect 建 DAP 帧通道（与 VS Code 同口径）。
 *
 * 传 port=0 让系统分配空闲端口（多窗口/多会话不撞车），监听行报真实端口。
 * 等监听行期间进程先死（崩溃/参数错）立即拒绝，不等超时。
 *
 * js-debug 独立服务器是伴随会话模型：根连接 launch 后经 startDebugging
 * 反向请求要求客户端用 __pendingTargetId 开第二条连接（真实调试会话），
 * tcpConnectTransportFactory 用于这条直连（不 spawn、不拥有进程）。
 */
import net from "node:net";
import type { DapChildProcess, DapTransportBinding, DapTransportFactory } from "./dap-client.js";

const LISTEN_LINE = /listening at (.+):(\d+)/;

/** 建 socket 通道（共享：根连接等监听行后调用；伴随连接直接调用）。 */
function connectSocket(host: string, port: number, onDead: (reason: string) => void): Promise<DapTransportBinding> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(port, host);
    // 常驻 error 监听防未捕获抛崩；建连前失败→拒绝，建连后→close 事件归一
    socket.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`DW_DAP_CONNECT_FAILED:${error.message}`));
      }
    });
    socket.once("connect", () => {
      settled = true;
      socket.on("close", () => onDead("DW_DAP_SOCKET_CLOSED"));
      resolve({
        transport: {
          write: (frame) => {
            socket.write(frame, "utf-8");
          },
          close: () => socket.destroy(),
        },
        data: socket,
        address: { host, port },
      });
    });
  });
}

/** js-debug 适配器传输工厂：spawn 服务器 → 解析监听行 → 建连。listenTimeoutMs 覆盖慢机器启动。 */
export function tcpServerTransportFactory(listenTimeoutMs = 10_000): DapTransportFactory {
  return (proc: DapChildProcess, onDead: (reason: string) => void): Promise<DapTransportBinding> =>
    new Promise((resolve, reject) => {
      let buf = "";
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        proc.stdout.removeListener("data", onStdout);
        proc.removeListener("exit", onProcExit);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new Error("DW_DAP_LISTEN_TIMEOUT"));
      }, listenTimeoutMs);

      const onProcExit = (code: number | null): void => {
        fail(new Error(`DW_DAP_ADAPTER_EXIT:${code ?? "signal"}`));
      };

      const onStdout = (chunk: Buffer): void => {
        buf += chunk.toString("utf-8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const match = LISTEN_LINE.exec(buf.slice(0, nl));
        if (match === null) return; // 非监听行（告警等），继续等
        const host = match[1] ?? "127.0.0.1";
        const port = Number.parseInt(match[2] ?? "0", 10);
        settled = true;
        cleanup();
        connectSocket(host, port, onDead).then(resolve, reject);
      };

      proc.stdout.on("data", onStdout);
      proc.on("exit", onProcExit);
    });
}

/** 伴随会话直连工厂：连已知地址的 js-debug 服务器（proc 为空壳门面，不拥有进程）。 */
export function tcpConnectTransportFactory(host: string, port: number): DapTransportFactory {
  return (_proc: DapChildProcess, onDead: (reason: string) => void) => connectSocket(host, port, onDead);
}
