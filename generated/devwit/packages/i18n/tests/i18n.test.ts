import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DICTIONARIES, LOCALES, type MessageKey } from "../src/messages.js";
import { getLocale, onDidChangeLocale, setLocale, t, ta } from "../src/index.js";

describe("i18n 词典", () => {
  it("两份词典键集完全同型（编译期 Messages 约束的运行期复核）", () => {
    const zh = Object.keys(DICTIONARIES["zh-CN"]).sort();
    const en = Object.keys(DICTIONARIES["en-US"]).sort();
    assert.deepEqual(en, zh);
    for (const key of zh as MessageKey[]) {
      assert.equal(
        typeof DICTIONARIES["en-US"][key],
        typeof DICTIONARIES["zh-CN"][key],
        `键 ${key} 在中英词典中类型不一致`
      );
      assert.notEqual(String(DICTIONARIES["en-US"][key]).trim(), "", `键 ${key} 英文文案为空`);
    }
  });

  it("LOCALES 与词典一一对应", () => {
    for (const locale of LOCALES) {
      assert.ok(DICTIONARIES[locale], `缺少 ${locale} 词典`);
    }
  });
});

describe("locale store", () => {
  it("默认 zh-CN；setLocale 切换后 t/ta 走新语言", () => {
    assert.equal(getLocale(), "zh-CN");
    assert.equal(t("chat.send"), "发送");
    setLocale("en-US");
    try {
      assert.equal(getLocale(), "en-US");
      assert.equal(t("chat.send"), "Send");
      assert.ok(ta("onboarding.examples")[0]?.includes("input validation"));
    } finally {
      setLocale("zh-CN");
    }
  });

  it("重复设置相同 locale 不触发变更事件", () => {
    let fired = 0;
    const off = onDidChangeLocale(() => {
      fired += 1;
    });
    setLocale("zh-CN");
    assert.equal(fired, 0);
    setLocale("en-US");
    assert.equal(fired, 1);
    off();
    setLocale("zh-CN");
  });

  it("t() 插值：{name} 被 vars 替换，未提供的占位符原样保留", () => {
    assert.equal(t("review.title", { path: "a.ts" }), "变更审查 — a.ts");
    assert.equal(t("diff.hunk", { id: 3, line: 42 }), "变更块 #3（第 42 行起）");
    assert.equal(t("review.title"), "变更审查 — {path}");
  });

  it("ta() 返回拷贝：调用方修改不污染词典", () => {
    const first = ta("chat.empty.lines");
    first.push("polluted");
    assert.notEqual(ta("chat.empty.lines").length, first.length);
  });
});
