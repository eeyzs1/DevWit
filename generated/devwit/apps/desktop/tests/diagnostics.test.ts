import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectTscDiagnostics, parseTscOutput } from "../src/main/diagnostics.js";

describe("parseTscOutput", () => {
  const ROOT = path.resolve(os.tmpdir(), "diag-ws");

  it("标准行解析：路径/行列/严重级/诊断码/消息齐备，路径归一化为工作区相对正斜杠", () => {
    const out = [
      "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/util/helper.ts(10,1): warning TS6133: 'x' is declared but its value is never read.",
    ].join("\n");
    const entries = parseTscOutput(out, ROOT);
    expect(entries).toEqual([
      {
        file: "src/index.ts",
        line: 3,
        column: 7,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        file: "src/util/helper.ts",
        line: 10,
        column: 1,
        severity: "warning",
        code: "TS6133",
        message: "'x' is declared but its value is never read.",
      },
    ]);
  });

  it("绝对路径行归一化为相对；非诊断行（横幅/空行/摘要）忽略", () => {
    const absFile = path.join(ROOT, "src", "a.ts");
    const out = [
      "",
      `${absFile}(1,5): error TS2304: Cannot find name 'foo'.`,
      "2 errors found.",
      "random noise line",
    ].join("\n");
    const entries = parseTscOutput(out, ROOT);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.file).toBe("src/a.ts");
    expect(entries[0]?.code).toBe("TS2304");
  });

  it("条目上限 50（防超大仓库刷屏耗尽上下文 token）", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts(1,1): error TS9999: boom ${i}`);
    expect(parseTscOutput(lines.join("\n"), ROOT)).toHaveLength(50);
  });
});

describe("collectTscDiagnostics 降级链", () => {
  it("无 tsconfig.json → []（非 TS 项目不诊断）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-no-tsconfig-"));
    try {
      expect(await collectTscDiagnostics(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("有 tsconfig 但无本地 typescript → []（不用 npx 联网/全局 tsc，诚实降级）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-no-tsc-"));
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}\n", "utf-8");
      expect(await collectTscDiagnostics(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
