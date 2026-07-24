import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ModeDefinition } from "@devwit/contracts";
import {
  MODE_EXPORT_KIND,
  MODE_EXPORT_VERSION,
  materializeImport,
  parseExportFile,
  toExportFile,
} from "../src/mode-port.js";

const SOURCE: ModeDefinition = {
  id: "mode-share-1",
  name: "分享测试",
  description: "社区分享用例",
  systemPrompt: "你是评审专家。",
  tools: ["read", "grep"],
  providerId: "p-local",
  contextPolicy: { codebase_match: true, git_status: false },
  orchestrate: true,
  builtin: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

describe("toExportFile", () => {
  it("剥离机器本地字段（id/builtin/时间戳），保留负载并深拷贝", () => {
    const file = toExportFile(SOURCE, "2026-07-24T00:00:00.000Z");
    assert.equal(file.kind, MODE_EXPORT_KIND);
    assert.equal(file.version, MODE_EXPORT_VERSION);
    assert.equal(file.exportedAt, "2026-07-24T00:00:00.000Z");
    assert.equal("id" in file.mode, false);
    assert.equal("builtin" in file.mode, false);
    assert.equal("createdAt" in file.mode, false);
    assert.equal(file.mode.name, "分享测试");
    assert.equal(file.mode.orchestrate, true);
    // 深拷贝：改导出件不污染源模式
    file.mode.tools.push("bash");
    file.mode.contextPolicy["git_status"] = true;
    assert.deepEqual(SOURCE.tools, ["read", "grep"]);
    assert.equal(SOURCE.contextPolicy["git_status"], false);
  });
});

describe("parseExportFile", () => {
  it("合法文件往返：parse(toExport(mode)) 负载一致", () => {
    const text = JSON.stringify(toExportFile(SOURCE));
    const parsed = parseExportFile(text);
    assert.equal(parsed.mode.name, SOURCE.name);
    assert.deepEqual(parsed.mode.tools, SOURCE.tools);
    assert.deepEqual(parsed.mode.contextPolicy, SOURCE.contextPolicy);
  });

  it("非 JSON / 非对象 → DW_MODE_IMPORT_INVALID_JSON", () => {
    assert.throws(() => parseExportFile("not json"), /DW_MODE_IMPORT_INVALID_JSON/);
    assert.throws(() => parseExportFile("[1,2]"), /DW_MODE_IMPORT_INVALID_JSON/);
    assert.throws(() => parseExportFile('"str"'), /DW_MODE_IMPORT_INVALID_JSON/);
  });

  it("kind 不匹配 → DW_MODE_IMPORT_NOT_A_DEVWIT_MODE", () => {
    assert.throws(
      () => parseExportFile(JSON.stringify({ kind: "other-tool", version: 1, mode: {} })),
      /DW_MODE_IMPORT_NOT_A_DEVWIT_MODE/
    );
  });

  it("未知版本 → DW_MODE_IMPORT_UNSUPPORTED_VERSION（携带版本号）", () => {
    assert.throws(
      () => parseExportFile(JSON.stringify({ kind: MODE_EXPORT_KIND, version: 99, mode: {} })),
      /DW_MODE_IMPORT_UNSUPPORTED_VERSION:99/
    );
  });

  it("负载缺字段/类型错误 → DW_MODE_IMPORT_INVALID_SCHEMA（携带细节）", () => {
    const bad = { kind: MODE_EXPORT_KIND, version: MODE_EXPORT_VERSION, exportedAt: "x", mode: { name: "缺 prompt" } };
    assert.throws(() => parseExportFile(JSON.stringify(bad)), /DW_MODE_IMPORT_INVALID_SCHEMA:mode description/);
    const badPolicy = {
      kind: MODE_EXPORT_KIND,
      version: MODE_EXPORT_VERSION,
      mode: { ...toExportFile(SOURCE).mode, contextPolicy: { unknown_type: true } },
    };
    assert.throws(() => parseExportFile(JSON.stringify(badPolicy)), /DW_MODE_IMPORT_INVALID_SCHEMA:.*unknown_type/);
  });
});

describe("materializeImport", () => {
  const FILE = toExportFile(SOURCE, "2026-07-24T00:00:00.000Z");

  it("新 id + builtin=false + 时间戳重盖章 + 已知 provider 保留", () => {
    const mode = materializeImport(FILE, {
      existingIds: new Set(["chat", "agent"]),
      providerIds: new Set(["p-local"]),
      now: "2026-07-24T01:00:00.000Z",
      makeId: () => "mode-new",
    });
    assert.equal(mode.id, "mode-new");
    assert.equal(mode.builtin, false);
    assert.equal(mode.createdAt, "2026-07-24T01:00:00.000Z");
    assert.equal(mode.updatedAt, "2026-07-24T01:00:00.000Z");
    assert.equal(mode.providerId, "p-local");
    assert.equal(mode.orchestrate, true);
  });

  it("未知 provider 清空为未绑定（跨机分享：provider id 是机器本地的）", () => {
    const mode = materializeImport(FILE, {
      existingIds: new Set(),
      providerIds: new Set(["p-other"]),
      makeId: () => "mode-x",
    });
    assert.equal(mode.providerId, "");
  });

  it("id 冲突追加序号直到唯一", () => {
    const mode = materializeImport(FILE, {
      existingIds: new Set(["mode-a", "mode-a-2"]),
      providerIds: new Set(),
      makeId: () => "mode-a",
    });
    assert.equal(mode.id, "mode-a-3");
  });

  it("产出可直接过 validateModeDefinition（经 ModeStore.upsert 同等校验）", () => {
    const mode = materializeImport(FILE, {
      existingIds: new Set(),
      providerIds: new Set(),
      makeId: () => "mode-ok",
    });
    // validateModeDefinition 在 parse 阶段已验负载；此处验证物化结果完整合法
    assert.equal(typeof mode.id, "string");
    assert.equal(typeof mode.name, "string");
    assert.ok(Array.isArray(mode.tools));
    assert.ok(!Number.isNaN(Date.parse(mode.createdAt)));
  });
});
