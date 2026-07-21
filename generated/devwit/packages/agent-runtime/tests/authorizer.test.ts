import type { AuthorizationDecision, AuthorizationRequest } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { Authorizer, buildAuthorizationReason } from "../src/authorizer.js";

describe("Authorizer（AC4 授权门）", () => {
  it("write/edit/bash 需授权；read/grep/find/ls 只读免授权", () => {
    const authorizer = new Authorizer();
    expect(authorizer.needsAuthorization("write")).toBe(true);
    expect(authorizer.needsAuthorization("edit")).toBe(true);
    expect(authorizer.needsAuthorization("bash")).toBe(true);
    expect(authorizer.needsAuthorization("read")).toBe(false);
    expect(authorizer.needsAuthorization("grep")).toBe(false);
    expect(authorizer.needsAuthorization("find")).toBe(false);
    expect(authorizer.needsAuthorization("ls")).toBe(false);
  });

  it("handler 路径：allow/deny 直接裁决；allow_session 后会话内免再问", async () => {
    const decisions: AuthorizationDecision[] = ["allow_session", "allow"];
    const seen: AuthorizationRequest[] = [];
    const authorizer = new Authorizer(async (request) => {
      seen.push(request);
      return decisions.shift() ?? "deny";
    });

    const first = await authorizer.requestAuthorization("write", { path: "a.txt" }, "写入文件: a.txt");
    expect(first.decision).toBe("allow_session");
    expect(first.request.id).toMatch(/^auth-/);
    expect(authorizer.needsAuthorization("write")).toBe(false);

    // 会话级放行后不再触发 handler
    await authorizer.requestAuthorization("bash", { command: "ls" }, "执行命令: ls");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.toolName).toBe("bash");
  });

  it("pending 路径：无 handler 时挂起，decide 裁决；未知 id 返回 false", async () => {
    const authorizer = new Authorizer();
    const pendingPromise = authorizer.requestAuthorization("edit", { path: "b.txt" }, "修改文件: b.txt");
    const pending = authorizer.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("edit");
    expect(authorizer.decide("auth-不存在的id", "allow")).toBe(false);
    expect(authorizer.decide(pending[0]?.id ?? "", "deny")).toBe(true);
    const { decision } = await pendingPromise;
    expect(decision).toBe("deny");
    expect(authorizer.listPending()).toHaveLength(0);
  });

  it("denyAllPending：会话取消时全部按 deny 收尾", async () => {
    const authorizer = new Authorizer();
    const p1 = authorizer.requestAuthorization("write", {}, "r1");
    const p2 = authorizer.requestAuthorization("bash", {}, "r2");
    expect(authorizer.listPending()).toHaveLength(2);
    authorizer.denyAllPending();
    expect((await p1).decision).toBe("deny");
    expect((await p2).decision).toBe("deny");
    expect(authorizer.listPending()).toHaveLength(0);
  });
});

describe("buildAuthorizationReason", () => {
  it("按工具生成人类可读理由", () => {
    expect(buildAuthorizationReason("write", { path: "src/a.ts" })).toBe("写入文件: src/a.ts");
    expect(buildAuthorizationReason("edit", { path: "src/a.ts" })).toBe("修改文件: src/a.ts");
    expect(buildAuthorizationReason("bash", { command: "npm test" })).toBe("执行命令: npm test");
    expect(buildAuthorizationReason("write", {})).toBe("写入文件: (未知路径)");
  });
});
