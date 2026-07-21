import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecOptions, ExecResult, ToolEnvironment } from "./tools.js";

export interface NodeEnvironmentOptions {
  /** bash 默认超时（毫秒），可被工具参数 timeout_ms 覆盖。 */
  defaultTimeoutMs?: number;
  /** exec maxBuffer（字节），超出即终止进程。 */
  maxBufferBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 真实工具执行环境（主进程用）：node:fs/promises 读写列目录、
 * node:child_process.exec 真实起 shell 进程。无 mock（符合全局约束：
 * 文件系统与终端均为真实调用）。WU006 的 PTY 复用落地后，apps 层可
 * 以 terminal 服务的实现替换 exec——接口不变。
 */
export function createNodeEnvironment(options: NodeEnvironmentOptions = {}): ToolEnvironment {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;

  return {
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, "utf-8");
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    },

    async listDir(dirPath: string) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },

    exec(command: string, execOptions: ExecOptions): Promise<ExecResult> {
      return new Promise<ExecResult>((resolve) => {
        exec(
          command,
          {
            cwd: execOptions.cwd,
            timeout: execOptions.timeoutMs ?? defaultTimeoutMs,
            maxBuffer,
            windowsHide: true,
            ...(execOptions.signal ? { signal: execOptions.signal } : {}),
          },
          (error, stdout, stderr) => {
            // error.code 为数字 = 进程真实退出码；否则为启动失败/超时/中止，
            // 归为退出码 1 并把原因并入 stderr（保留 stdout，不丢现场）。
            if (error && typeof error.code !== "number") {
              resolve({
                stdout,
                stderr: stderr ? `${stderr}\n${error.message}` : error.message,
                exitCode: 1,
              });
              return;
            }
            resolve({ stdout, stderr, exitCode: error ? error.code ?? 1 : 0 });
          }
        );
      });
    },
  };
}
