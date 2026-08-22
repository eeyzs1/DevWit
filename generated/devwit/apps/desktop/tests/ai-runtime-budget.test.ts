/**
 * AiRuntime 成本预算自动告警（D1 成本预算仪表盘）真实文件系统回环测试。
 *
 * 不用 mock：真实 SettingsStore（NodeCryptoBackend）+ 真实 tmp 目录 usage.jsonl 账本。
 * 唯一注入边界是 LLMProvider——以确定性 StreamEvent 序列（含 usage 帧）驱动 run，
 * 验证：预算开启时超限跃迁推送一次 usage:budget-alert、连续超限不重复、
 * 回落复位、配置关闭/脏数据绝不告警。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, LLMProvider, ProviderConfig, StreamEvent, UsageBudgetAlert } from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import type { WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "../src/main/ai-runtime.js";

/** 脚本化 provider：按序回放 StreamEvent 脚本（含 usage 帧），记录调用次数。 */
class ScriptedProvider implements LLMProvider {
  readonly config: ProviderConfig = {
    id: "p-test",
    type: "openai",
    label: "scripted",
    baseUrl: "https://example.invalid",
    model: "test-model",
    credentialRef: "cred-test",
    maxTokens: 1024,
  };
  readonly calls: ChatMessage[][] = [];
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEvent[][]) {
    this.scripts = [...scripts];
  }

  streamChat(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const script: StreamEvent[] = this.scripts.shift() ?? [{ type: "done", stopReason: "end_turn" }];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of script) yield event;
      },
    };
  }
}

/** 单次 run 脚本：一次 usage 帧（1000 入 / 500 出）+ 直接完成。 */
function meteredRun(): StreamEvent[] {
  return [
    { type: "usage", inputTokens: 1000, outputTokens: 500 },
    { type: "done", stopReason: "end_turn" },
  ];
}

/** 单价 100/百万 → 单次 run 成本 = (1000*100 + 500*100) / 1e6 = 0.15。 */
const PRICING = { "p-test test-model": { inputPerMillion: 100, outputPerMillion: 100 } };

let tmpRoot = "";

function makeRuntime(provider: ScriptedProvider): { runtime: AiRuntime; sent: Array<{ channel: string; args: unknown[] }>; settings: SettingsStore } {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const settings = new SettingsStore(new NodeCryptoBackend(), path.join(tmpRoot, "settings"));
  const workspace = { readFile: async () => "", onDidChange: () => () => {} } as unknown as WorkspaceService;
  const runtime = new AiRuntime({
    settings,
    workspace,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
    manifestsDir: path.join(tmpRoot, "manifests"),
    tracesDir: path.join(tmpRoot, "traces"),
    createProvider: () => provider,
  });
  return { runtime, sent, settings };
}

function budgetAlerts(sent: Array<{ channel: string; args: unknown[] }>): UsageBudgetAlert[] {
  return sent.filter((entry) => entry.channel === IPC.UsageBudgetAlert).map((entry) => entry.args[0] as UsageBudgetAlert);
}

async function runOnce(runtime: AiRuntime, sessionId: string): Promise<void> {
  await runtime.run({
    sessionId,
    userText: "计量一次",
    modeId: "chat",
    providerId: "p-test",
    workspaceRoot: tmpRoot,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-budget-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("AiRuntime 成本预算自动告警（D1）", () => {
  it("未配置预算（键缺失）→ run 不推送任何告警", async () => {
    const provider = new ScriptedProvider([meteredRun()]);
    const { runtime, sent, settings } = makeRuntime(provider);
    await settings.set("usage.pricing", PRICING);
    await runOnce(runtime, "s-1");
    expect(budgetAlerts(sent)).toEqual([]);
  });

  it("预算关闭（enabled=false）→ 不推送告警", async () => {
    const provider = new ScriptedProvider([meteredRun()]);
    const { runtime, sent, settings } = makeRuntime(provider);
    await settings.set("usage.pricing", PRICING);
    await settings.set("usage.budget", { enabled: false, threshold: 0.1, period: "total" });
    await runOnce(runtime, "s-1");
    expect(budgetAlerts(sent)).toEqual([]);
  });

  it("脏数据（enabled=true 但阈值/周期非法）→ 安全默认不告警", async () => {
    const provider = new ScriptedProvider([meteredRun()]);
    const { runtime, sent, settings } = makeRuntime(provider);
    await settings.set("usage.pricing", PRICING);
    await settings.set("usage.budget", { enabled: true, threshold: "0.1", period: "nope" });
    await runOnce(runtime, "s-1");
    expect(budgetAlerts(sent)).toEqual([]);
  });

  it("超限跃迁推送一次；连续超限不重复；回落复位后再次超限再推送", async () => {
    const provider = new ScriptedProvider([meteredRun(), meteredRun(), meteredRun(), meteredRun()]);
    const { runtime, sent, settings } = makeRuntime(provider);
    await settings.set("usage.pricing", PRICING);
    await settings.set("usage.budget", { enabled: true, threshold: 0.1, period: "total" });

    // run1：0.15 ≥ 0.1 → 首次超限跃迁，推送一次
    await runOnce(runtime, "s-1");
    let alerts = budgetAlerts(sent);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 0.1, exceeded: true, period: "total" });
    expect(alerts[0]!.current).toBeCloseTo(0.15, 6);

    // run2：0.30 仍超限 → 连续超限不重复推送
    await runOnce(runtime, "s-2");
    expect(budgetAlerts(sent)).toHaveLength(1);

    // 阈值调高到 1.0 → run3：0.45 < 1.0 回落（复位跃迁状态）
    await settings.set("usage.budget", { enabled: true, threshold: 1.0, period: "total" });
    await runOnce(runtime, "s-3");
    expect(budgetAlerts(sent)).toHaveLength(1);

    // 阈值调回 0.1 → run4：0.60 ≥ 0.1 再次跃迁，推送一次
    await settings.set("usage.budget", { enabled: true, threshold: 0.1, period: "total" });
    await runOnce(runtime, "s-4");
    alerts = budgetAlerts(sent);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]!.current).toBeCloseTo(0.6, 6);
  });

  it("按日周期：两次同日内 run 累计 0.30 ≥ 0.2 → 推送一次", async () => {
    const provider = new ScriptedProvider([meteredRun(), meteredRun()]);
    const { runtime, sent, settings } = makeRuntime(provider);
    await settings.set("usage.pricing", PRICING);
    await settings.set("usage.budget", { enabled: true, threshold: 0.2, period: "day" });
    await runOnce(runtime, "s-1");
    await runOnce(runtime, "s-2");
    const alerts = budgetAlerts(sent);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.current).toBeCloseTo(0.3, 6);
  });
});
