import { describe, expect, it } from "vitest";
import { isAuthorizationGranted } from "@devwit/contracts";
import { Authorizer } from "../src/authorizer.js";

describe("Authorizer fail-closed（B-WU3，借鉴 DSH 授权闭集）", () => {
  it("isAuthorizationGranted：只有 allow/allow_session 放行；deny/cancelled/unavailable 一律拒绝", () => {
    expect(isAuthorizationGranted("allow")).toBe(true);
    expect(isAuthorizationGranted("allow_session")).toBe(true);
    expect(isAuthorizationGranted("deny")).toBe(false);
    expect(isAuthorizationGranted("cancelled")).toBe(false);
    expect(isAuthorizationGranted("unavailable")).toBe(false);
  });

  it("handler 抛错 → unavailable（fail-closed：拿不到裁决就不放行）", async () => {
    const auth = new Authorizer(async () => {
      throw new Error("answerer broken");
    });
    const { decision } = await auth.requestAuthorization("write", { path: "x" }, "测试");
    expect(decision).toBe("unavailable");
    expect(isAuthorizationGranted(decision)).toBe(false);
  });

  it("无 handler 时进入 pending；cancelPending 按 cancelled 收尾", async () => {
    const auth = new Authorizer();
    const pending = auth.requestAuthorization("write", { path: "x" }, "测试");
    // requestAuthorization 同步注册 pending；给 microtask 一个 tick 确保注册完成
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(auth.listPending()).toHaveLength(1);
    auth.cancelPending();
    const { decision } = await pending;
    expect(decision).toBe("cancelled");
    expect(isAuthorizationGranted(decision)).toBe(false);
    expect(auth.listPending()).toHaveLength(0);
  });

  it("decide 非归属/未知 id 返回 false（不产生裁决）", () => {
    const auth = new Authorizer();
    expect(auth.decide("auth-nope", "allow")).toBe(false);
  });

  it("denyAllPending 仍按 deny 收尾（向后兼容）", async () => {
    const auth = new Authorizer();
    const pending = auth.requestAuthorization("bash", { command: "npm test" }, "测试");
    await new Promise((resolve) => setTimeout(resolve, 0));
    auth.denyAllPending();
    const { decision } = await pending;
    expect(decision).toBe("deny");
    expect(isAuthorizationGranted(decision)).toBe(false);
  });
});
