import { describe, expect, it } from "vitest";
import { isTokenScope, scopeForNodeType, TOKEN_SCOPES } from "../src/index.js";

describe("scopeForNodeType 命名节点", () => {
  it("字符串家族 → string", () => {
    for (const type of ["string", "string_literal", "template_string", "char_literal", "raw_string_literal"]) {
      expect(scopeForNodeType(type, true)).toBe("string");
    }
  });

  it("注释家族 → comment", () => {
    expect(scopeForNodeType("comment", true)).toBe("comment");
    expect(scopeForNodeType("line_comment", true)).toBe("comment");
    expect(scopeForNodeType("block_comment", true)).toBe("comment");
  });

  it("数字家族 → number", () => {
    for (const type of ["number", "integer", "float", "number_literal"]) {
      expect(scopeForNodeType(type, true)).toBe("number");
    }
  });

  it("常量：JS true/false/null 与 Python None 均为命名节点 → constant", () => {
    for (const type of ["true", "false", "null", "none", "undefined"]) {
      expect(scopeForNodeType(type, true)).toBe("constant");
    }
  });

  it("标识符类：variable / property / type", () => {
    expect(scopeForNodeType("identifier", true)).toBe("variable");
    expect(scopeForNodeType("property_identifier", true)).toBe("property");
    expect(scopeForNodeType("shorthand_property_identifier", true)).toBe("property");
    expect(scopeForNodeType("type_identifier", true)).toBe("type");
    expect(scopeForNodeType("predefined_type", true)).toBe("type");
  });

  it("this/super 是命名节点 → keyword；tag/attribute 覆盖标记语言", () => {
    expect(scopeForNodeType("this", true)).toBe("keyword");
    expect(scopeForNodeType("super", true)).toBe("keyword");
    expect(scopeForNodeType("tag_name", true)).toBe("tag");
    expect(scopeForNodeType("attribute_name", true)).toBe("attribute");
  });

  it("未收录的命名节点（如 program/statement_block）→ undefined", () => {
    expect(scopeForNodeType("program", true)).toBeUndefined();
    expect(scopeForNodeType("statement_block", true)).toBeUndefined();
    expect(scopeForNodeType("call_expression", true)).toBeUndefined();
  });
});

describe("scopeForNodeType 匿名 token", () => {
  it("TS/JS 关键字 → keyword", () => {
    for (const kw of ["if", "else", "return", "const", "let", "class", "interface", "async", "await", "import", "export", "type"]) {
      expect(scopeForNodeType(kw, false)).toBe("keyword");
    }
  });

  it("Python 关键字 → keyword", () => {
    for (const kw of ["def", "elif", "lambda", "with", "raise", "except", "pass", "match"]) {
      expect(scopeForNodeType(kw, false)).toBe("keyword");
    }
  });

  it("运算符 → operator", () => {
    for (const op of ["+", "-", "===", "!==", "=>", "?.", "??", "**", ":=", "<<="]) {
      expect(scopeForNodeType(op, false)).toBe("operator");
    }
  });

  it("标点 → punctuation", () => {
    for (const p of ["(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "...", "->"]) {
      expect(scopeForNodeType(p, false)).toBe("punctuation");
    }
  });

  it("未命中匿名 token → undefined", () => {
    expect(scopeForNodeType("foo", false)).toBeUndefined();
    expect(scopeForNodeType("elifx", false)).toBeUndefined();
  });
});

describe("named 标志区分两张表", () => {
  it("匿名关键字以 named=true 查询 → undefined（不串命名表）", () => {
    expect(scopeForNodeType("if", true)).toBeUndefined();
    expect(scopeForNodeType("def", true)).toBeUndefined();
  });

  it("命名节点类型以 named=false 查询 → undefined（不串匿名表）", () => {
    expect(scopeForNodeType("string", false)).toBeUndefined();
    expect(scopeForNodeType("identifier", false)).toBeUndefined();
  });
});

describe("isTokenScope / TOKEN_SCOPES", () => {
  it("全部合法 scope 通过类型守卫", () => {
    for (const scope of TOKEN_SCOPES) {
      expect(isTokenScope(scope)).toBe(true);
    }
  });

  it("非法值被类型守卫拒绝", () => {
    expect(isTokenScope("keyword2")).toBe(false);
    expect(isTokenScope("")).toBe(false);
    expect(isTokenScope("Keyword")).toBe(false);
  });

  it("TOKEN_SCOPES 覆盖渲染层约定的 15 个 scope 且无重复", () => {
    expect(TOKEN_SCOPES).toHaveLength(15);
    expect(new Set(TOKEN_SCOPES).size).toBe(15);
  });
});
