import path from "node:path";
import type { ChatMessage, LLMProvider, ProviderConfig, StreamEvent, ToolDefinition } from "@devwit/contracts";
import type { DirEntry, ExecOptions, ExecResult, ToolEnvironment } from "../src/tools.js";

/**
 * 内存工具环境：ToolEnvironment 端口的测试替身（非 mock——文件/终端的
 * 真实实现是 shell.ts 的 NodeEnvironment，在 shell.test.ts 中以真实
 * fs/child_process 验证；此处用于确定性驱动工具与 loop 的分支逻辑）。
 */
export class MemoryEnvironment implements ToolEnvironment {
  readonly root: string;
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  readonly execCalls: Array<{ command: string; cwd: string }> = [];
  execHandler: (command: string, options: ExecOptions) => Promise<ExecResult> = async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });

  constructor(root: string, files: Record<string, string> = {}) {
    this.root = path.resolve(root);
    this.dirs.add(this.root);
    for (const [name, content] of Object.entries(files)) {
      const full = path.resolve(this.root, name);
      this.files.set(full, content);
      this.registerAncestors(full);
    }
  }

  private registerAncestors(filePath: string): void {
    let dir = path.dirname(filePath);
    while (!this.dirs.has(dir)) {
      this.dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${filePath}`);
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
    this.registerAncestors(filePath);
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    if (!this.dirs.has(dirPath)) throw new Error(`ENOENT: no such directory: ${dirPath}`);
    const prefix = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
    const names = new Map<string, boolean>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const sepIndex = rest.indexOf(path.sep);
      if (sepIndex === -1) names.set(rest, false);
      else names.set(rest.slice(0, sepIndex), true);
    }
    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, cwd: options.cwd });
    return this.execHandler(command, options);
  }

  /** 按工作区相对路径读取（测试断言用）。 */
  readRelative(relativePath: string): string | undefined {
    return this.files.get(path.resolve(this.root, relativePath));
  }
}

/**
 * 脚本化 provider：LLMProvider 接口边界的测试替身。HTTP/SSE 协议层
 * 已由 llm-providers 的录制 fixture 测试覆盖；此处以确定性 StreamEvent
 * 序列驱动 agent loop 的分支（工具调用/授权/错误/取消）。
 */
export class ScriptedProvider implements LLMProvider {
  readonly config: ProviderConfig = {
    id: "p-test",
    type: "openai",
    label: "scripted",
    baseUrl: "https://example.invalid",
    model: "test-model",
    credentialRef: "cred-test",
    maxTokens: 1024,
  };
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }> = [];
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEvent[][]) {
    this.scripts = [...scripts];
  }

  streamChat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, tools });
    const script: StreamEvent[] = this.scripts.shift() ?? [{ type: "done", stopReason: "end_turn" }];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of script) yield event;
      },
    };
  }
}
