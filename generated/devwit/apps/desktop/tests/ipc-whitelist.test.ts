/**
 * IPC 白名单完整性测试（AR001/AR004）。
 * 在纯 node 环境运行：ipc.ts 不 import electron，handlers 表经依赖注入构建。
 * services 用最小自写测试替身（DI test double，非 mock 外部服务）。
 */
import { describe, expect, it, vi } from "vitest";
import { IPC } from "@devwit/contracts";
import {
  buildHandlerTable,
  PUSH_CHANNELS,
  registerIpcHandlers
} from "../src/main/ipc.js";
import type { IpcHooks, IpcMainLike, IpcServices } from "../src/main/ipc.js";

function fakeServices(): IpcServices {
  const services = {
    workspace: {
      openRoot: vi.fn(async (p: string) => p),
      readFile: vi.fn(async () => "content"),
      writeFile: vi.fn(async () => undefined),
      watch: vi.fn(),
      onDidChange: vi.fn(() => () => undefined),
      close: vi.fn()
    },
    terminal: {
      create: vi.fn(async () => ({ id: "t1", shell: "cmd", cwd: "c:\\", backend: "pipe", pid: 1234 })),
      write: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      onOutput: vi.fn(() => () => undefined),
      disposeAll: vi.fn()
    },
    settings: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
      setCredential: vi.fn(),
      deleteCredential: vi.fn(),
      listCredentials: vi.fn(() => []),
      resolve: vi.fn(async () => "sk-fake")
    }
  };
  return services as unknown as IpcServices;
}

function fakeHooks(): IpcHooks {
  return {
    openDirectoryDialog: vi.fn(async () => null),
    saveJsonFile: vi.fn(async () => null),
    openJsonFile: vi.fn(async () => null),
    buildTree: vi.fn(() => ({ name: "root", path: "/", type: "dir", children: [] })),
    send: vi.fn()
  };
}

describe("IPC 白名单", () => {
  it("handlers 表通道集合 == IPC 常量全集 − 推送通道（严格相等）", () => {
    const table = buildHandlerTable(fakeServices(), fakeHooks());
    const allChannels = Object.values(IPC) as string[];
    const expectedInvoke = allChannels.filter((c) => !PUSH_CHANNELS.includes(c)).sort();
    expect(Object.keys(table).sort()).toEqual(expectedInvoke);
  });

  it("invoke 通道与推送通道的并集 == IPC 常量全集，且无交集", () => {
    const table = buildHandlerTable(fakeServices(), fakeHooks());
    const invokeSet = new Set(Object.keys(table));
    const pushSet = new Set(PUSH_CHANNELS);
    const allSet = new Set(Object.values(IPC) as string[]);
    for (const ch of invokeSet) {
      expect(pushSet.has(ch)).toBe(false);
    }
    expect(new Set([...invokeSet, ...pushSet])).toEqual(allSet);
  });

  it("registerIpcHandlers 把全部 invoke 通道注册到 ipcMain", () => {
    const registered: string[] = [];
    const ipcMainLike: IpcMainLike = {
      handle: (channel) => {
        registered.push(channel);
      }
    };
    registerIpcHandlers({ ipcMain: ipcMainLike, services: fakeServices(), hooks: fakeHooks() });
    const allChannels = Object.values(IPC) as string[];
    const expectedInvoke = allChannels.filter((c) => !PUSH_CHANNELS.includes(c)).sort();
    expect(registered.sort()).toEqual(expectedInvoke);
  });

  it("AI 子系统通道已注册但抛明确的未接线错误", () => {
    const table = buildHandlerTable(fakeServices(), fakeHooks());
    const aiChannels = [
      IPC.AgentRun,
      IPC.AgentCancel,
      IPC.AgentAuthorize,
      IPC.AgentTrace,
      IPC.ModesList,
      IPC.ModesUpsert,
      IPC.ModesDelete,
      IPC.ModesExport,
      IPC.ModesImport,
      IPC.ContextManifestLatest,
      IPC.ContextManifestList,
      IPC.McpList,
      IPC.McpUpsert,
      IPC.McpDelete,
      IPC.UsageSummary,
      IPC.UsageClear,
      IPC.UsageDaily,
      IPC.UsageBudget,
      IPC.UsageExport
    ];
    for (const ch of aiChannels) {
      const handler = table[ch];
      expect(handler, `${ch} 应已注册`).toBeDefined();
      expect(() => handler?.(null)).toThrow("DW_AI_NOT_WIRED");
    }
  });

  it("providers:list/upsert 为真实实现（存 settings 的 providers 键）", async () => {
    const services = fakeServices();
    const table = buildHandlerTable(services, fakeHooks());
    let stored: unknown[] = [];
    (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(() => stored);
    (services.settings.set as ReturnType<typeof vi.fn>).mockImplementation((_k: string, v: unknown) => {
      stored = v as unknown[];
    });
    const config = {
      id: "p1",
      type: "anthropic",
      label: "Claude",
      baseUrl: "https://example.invalid",
      model: "m",
      credentialRef: "ref1",
      maxTokens: 1024
    };
    await table[IPC.ProvidersUpsert]?.(null, config);
    const list = (await table[IPC.ProvidersList]?.(null)) as unknown[];
    expect(list).toHaveLength(1);
    expect((list[0] as { id: string }).id).toBe("p1");
    // upsert 同 id 为更新而非追加
    await table[IPC.ProvidersUpsert]?.(null, { ...config, label: "Claude 2" });
    const list2 = (await table[IPC.ProvidersList]?.(null)) as unknown[];
    expect(list2).toHaveLength(1);
  });

  it("providers:presets 返回 llm-providers 预设目录（AC22：含免 key Ollama 预设）", async () => {
    const table = buildHandlerTable(fakeServices(), fakeHooks());
    const presets = (await table[IPC.ProviderPresets]?.(null)) as Array<{ id: string; keyless: boolean; baseUrl: string }>;
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(0);
    const ollama = presets.find((preset) => preset.id === "ollama");
    expect(ollama?.keyless).toBe(true);
    expect(ollama?.baseUrl).toContain("localhost");
  });

  it("providers:probe（AC26）：非法请求拒绝；keyless 不触碰凭证存储；不可达抛 DW_PROBE_UNREACHABLE", async () => {
    const services = fakeServices();
    const table = buildHandlerTable(services, fakeHooks());
    // 非法请求：缺 type / baseUrl
    await expect(table[IPC.ProvidersProbe]?.(null, { type: "bogus", baseUrl: "x" })).rejects.toThrowError(
      "DW_PROBE_INVALID_URL"
    );
    // keyless + 未监听端口：settings.resolve 绝不应被调用（凭证逻辑整体跳过）
    const resolveSpy = services.settings.resolve as ReturnType<typeof vi.fn>;
    resolveSpy.mockClear();
    await expect(
      table[IPC.ProvidersProbe]?.(null, { type: "openai", baseUrl: "http://127.0.0.1:1/v1", keyless: true })
    ).rejects.toThrowError("DW_PROBE_UNREACHABLE");
    expect(resolveSpy).not.toHaveBeenCalled();
    // 非 keyless 且带 credentialRef：凭证经 settings.resolve 解析后参与探测
    resolveSpy.mockResolvedValueOnce("sk-from-store");
    await expect(
      table[IPC.ProvidersProbe]?.(null, { type: "openai", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "cred-p1" })
    ).rejects.toThrowError("DW_PROBE_UNREACHABLE");
    expect(resolveSpy).toHaveBeenCalledWith("cred-p1");
  });
});
