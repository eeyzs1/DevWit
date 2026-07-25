import type { AuthorizationDecision } from "@devwit/contracts";
import type { AuthorizationMemory } from "./authorizer.js";

/**
 * 命令白名单学习（迭代 20 / AC29，DI-I012）：
 * 从用户授权历史学习高频安全命令，同类命令免重复确认。
 *
 * 安全语义（刻意保守）：
 * - 仅 bash 工具参与学习——write/edit 按路径授权、MCP 工具默认最严，均不在范围内；
 * - 精确匹配：命令经空白归一化（trim + 连续空白折叠为单空格）后全串相等才命中，
 *   不做 glob/前缀推断——"git status" 学会不代表 "git status -s" 免问；
 * - 仅 decision === "allow" 计入学习：deny 是负信号、allow_session 已是工具级放行；
 * - 达到阈值（默认 2 次批准）才毕业进白名单，防一次性误批即永久放行；
 * - 学习可整体停用（learning.enabled=false 时命中检查与计数都短路）。
 */

/** 空白归一化：trim + 连续空白折叠为单空格（"npm  test"≡"npm test"）。 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export interface WhitelistLearningConfig {
  enabled: boolean;
  /** 毕业阈值：同一命令被批准 N 次后加入白名单（>=1）。 */
  threshold: number;
}

export interface CommandWhitelistSnapshot {
  whitelist: string[];
  /** 学习中的命令 → 已批准次数（未达阈值）。 */
  approvals: Record<string, number>;
  learning: WhitelistLearningConfig;
}

/** 存储适配：由 apps 层桥到 settings（读快照 / 原子写回）。 */
export interface CommandWhitelistStore {
  read(): CommandWhitelistSnapshot;
  write(whitelist: string[], approvals: Record<string, number>): void;
}

export const DEFAULT_LEARNING: WhitelistLearningConfig = { enabled: true, threshold: 2 };

export class CommandWhitelistMemory implements AuthorizationMemory {
  constructor(
    private readonly store: CommandWhitelistStore,
    /** 命令毕业进白名单时回调（UI 提示用）；同步触发。 */
    private readonly onLearned?: (command: string) => void
  ) {}

  isWhitelisted(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName !== "bash") return false;
    const snapshot = this.store.read();
    if (!snapshot.learning.enabled) return false;
    const command = this.commandOf(args);
    if (command === null) return false;
    return snapshot.whitelist.includes(command);
  }

  recordDecision(toolName: string, args: Record<string, unknown>, decision: AuthorizationDecision): void {
    if (toolName !== "bash" || decision !== "allow") return;
    const snapshot = this.store.read();
    if (!snapshot.learning.enabled) return;
    const command = this.commandOf(args);
    if (command === null || snapshot.whitelist.includes(command)) return;
    const count = (snapshot.approvals[command] ?? 0) + 1;
    const threshold = Math.max(1, snapshot.learning.threshold);
    if (count >= threshold) {
      const approvals = { ...snapshot.approvals };
      delete approvals[command];
      this.store.write([...snapshot.whitelist, command], approvals);
      this.onLearned?.(command);
    } else {
      this.store.write(snapshot.whitelist, { ...snapshot.approvals, [command]: count });
    }
  }

  private commandOf(args: Record<string, unknown>): string | null {
    const raw = args["command"];
    if (typeof raw !== "string") return null;
    const normalized = normalizeCommand(raw);
    return normalized === "" ? null : normalized;
  }
}
