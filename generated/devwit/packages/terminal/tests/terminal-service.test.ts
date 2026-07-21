import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalService } from "../src/terminal-service.js";

describe("TerminalService", () => {
  const service = new TerminalService();

  afterEach(() => {
    service.disposeAll();
  });

  it("create 返回会话，backend ∈ {pty, pipe}", async () => {
    const info = await service.create({ cwd: os.tmpdir() });
    expect(info.id).toBeTruthy();
    expect(["pty", "pipe"]).toContain(info.backend);
    expect(info.pid).toBeGreaterThan(0);
    expect(info.cwd).toBe(os.tmpdir());
    expect(service.get(info.id)?.id).toBe(info.id);
    service.dispose(info.id);
    expect(service.get(info.id)).toBeUndefined();
  });

  it("dispose 后 onData 不再触发", async () => {
    const info = await service.create({ cwd: os.tmpdir() });
    let count = 0;
    service.onOutput(info.id, () => {
      count += 1;
    });
    service.dispose(info.id);
    await new Promise((r) => setTimeout(r, 400));
    const settled = count;
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(settled);
  });

  it("未知会话 id 抛错", async () => {
    expect(() => service.write("no-such-id", "x")).toThrow(/Unknown terminal session/);
  });
});
