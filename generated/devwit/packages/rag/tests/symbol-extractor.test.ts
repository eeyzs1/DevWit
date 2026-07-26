import { describe, expect, it } from "vitest";
import type { SymbolKind } from "@devwit/contracts";
import { extractSymbols, filterSymbols, makeSymbolId, supportsSymbols, SYMBOL_MAX_LINES } from "../src/symbol-extractor.js";

/** 提取结果 → 可读的 (kind:name:parent:行区间) 元组，断言聚焦语义而非 id。 */
function brief(symbols: ReturnType<typeof extractSymbols>): string[] {
  return symbols.map(
    (s) => `${s.kind}:${s.name}${s.parentName !== undefined ? `@${s.parentName}` : ""}:L${s.startLine}-${s.endLine}`
  );
}

describe("supportsSymbols", () => {
  it("按扩展名白名单判定（大小写不敏感），C/C++ 保守跳过", () => {
    expect(supportsSymbols("src/a.ts")).toBe(true);
    expect(supportsSymbols("src/b.PY")).toBe(true);
    expect(supportsSymbols("main.go")).toBe(true);
    expect(supportsSymbols("lib.rs")).toBe(true);
    expect(supportsSymbols("a.c")).toBe(false);
    expect(supportsSymbols("a.cpp")).toBe(false);
    expect(supportsSymbols("README.md")).toBe(false);
    expect(supportsSymbols("Makefile")).toBe(false);
  });
});

describe("extractSymbols · TypeScript", () => {
  it("函数/类/接口/类型/枚举/常量 + 类方法归属", () => {
    const content = [
      "export function greet(name: string): string {",
      "  return `hi ${name}`;",
      "}",
      "",
      "export interface Greeter {",
      "  greet(name: string): string;",
      "}",
      "",
      "export type Alias = string | number;",
      "",
      "export enum Color {",
      "  Red,",
      "  Blue,",
      "}",
      "",
      "export const MAX_RETRY = 3;",
      "",
      "export class Bot implements Greeter {",
      "  private mood = 0;",
      "",
      "  greet(name: string): string {",
      "    return greet(name);",
      "  }",
      "",
      "  async reset(): Promise<void> {",
      "    this.mood = 0;",
      "  }",
      "}",
    ].join("\n");
    const symbols = extractSymbols("src/bot.ts", content);
    expect(brief(symbols)).toEqual([
      "function:greet:L1-3",
      "interface:Greeter:L5-7",
      "type:Alias:L9-9",
      "enum:Color:L11-14",
      "constant:MAX_RETRY:L16-16",
      "class:Bot:L18-28",
      "method:greet@Bot:L21-23",
      "method:reset@Bot:L25-27",
    ]);
    // 声明行原文（signature）供候选下拉展示
    const bot = symbols.find((s) => s.name === "Bot");
    expect(bot?.signature).toBe("export class Bot implements Greeter {");
  });

  it("大括号定界不受字符串/行注释内的括号干扰", () => {
    const content = [
      'function tricky(): string {',
      '  const a = "}{{{";',
      "  // }}} 注释里的括号",
      '  const tpl = `x${1 + 2}y`;',
      "  return a;",
      "}",
      "function after(): number {",
      "  return 1;",
      "}",
    ].join("\n");
    const symbols = extractSymbols("a.ts", content);
    expect(brief(symbols)).toEqual(["function:tricky:L1-6", "function:after:L7-9"]);
  });

  it("方法名排除控制流关键字（if/for/while 不误提为方法）", () => {
    const content = [
      "class Flow {",
      "  run(): void {",
      "    if (true) {",
      "      for (let i = 0; i < 1; i++) {",
      "        while (false) {}",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const symbols = extractSymbols("flow.ts", content);
    expect(brief(symbols)).toEqual(["class:Flow:L1-9", "method:run@Flow:L2-8"]);
  });

  it("单行方法（声明与闭合同行）也归属容器", () => {
    const content = [
      "class Outer {",
      "  outerM(): void {}",
      "  innerHelper(): void {}",
      "}",
    ].join("\n");
    const symbols = extractSymbols("n.ts", content);
    const outer = symbols.find((s) => s.name === "Outer");
    const m = symbols.find((s) => s.name === "outerM");
    expect(outer?.kind).toBe("class");
    expect(m?.parentName).toBe("Outer");
    expect(brief(symbols)).toEqual([
      "class:Outer:L1-4",
      "method:outerM@Outer:L2-2",
      "method:innerHelper@Outer:L3-3",
    ]);
  });
});

describe("extractSymbols · Python（缩进定界）", () => {
  it("类/def/常量 + 方法归属；块延伸至缩进回落", () => {
    const content = [
      "MAX_CONN = 10",
      "",
      "class Repo:",
      "    def fetch(self, key):",
      "        return self.db[key]",
      "",
      "    def close(self):",
      "        self.db.close()",
      "",
      "async def main():",
      "    repo = Repo()",
      "    await repo.close()",
    ].join("\n");
    const symbols = extractSymbols("app/main.py", content);
    expect(brief(symbols)).toEqual([
      "constant:MAX_CONN:L1-1",
      "class:Repo:L3-8",
      "method:fetch@Repo:L4-5",
      "method:close@Repo:L7-8",
      "function:main:L10-12",
    ]);
  });
});

describe("extractSymbols · Go", () => {
  it("接收者方法 parent 取接收者类型；struct→class / interface", () => {
    const content = [
      "package store",
      "",
      "type Rect struct {",
      "\tW int",
      "\tH int",
      "}",
      "",
      "func (r *Rect) Area() int {",
      "\treturn r.W * r.H",
      "}",
      "",
      "func NewRect(w int, h int) *Rect {",
      "\treturn &Rect{W: w, H: h}",
      "}",
      "",
      "type Shape interface {",
      "\tArea() int",
      "}",
    ].join("\n");
    const symbols = extractSymbols("geo.go", content);
    expect(brief(symbols)).toEqual([
      "class:Rect:L3-6",
      "method:Area@Rect:L8-10",
      "function:NewRect:L12-14",
      "interface:Shape:L16-18",
    ]);
  });
});

describe("extractSymbols · Rust", () => {
  it("impl 容器内方法归属；trait→interface；mod→module", () => {
    const content = [
      "pub struct Point {",
      "    x: f64,",
      "}",
      "",
      "impl Point {",
      "    pub fn new(x: f64) -> Self {",
      "        Self { x }",
      "    }",
      "",
      "    fn raw(&self) -> f64 {",
      "        self.x",
      "    }",
      "}",
      "",
      "pub trait Draw {",
      "    fn draw(&self);",
      "}",
      "",
      "mod utils {",
      "    fn helper() {}",
      "}",
    ].join("\n");
    const symbols = extractSymbols("src/lib.rs", content);
    expect(brief(symbols)).toEqual([
      "class:Point:L1-3",
      "module:Point:L5-13",
      "method:new@Point:L6-8",
      "method:raw@Point:L10-12",
      "interface:Draw:L15-17",
      "module:utils:L19-21",
    ]);
  });
});

describe("extractSymbols · JVM 系（Java/Kotlin）", () => {
  it("Java：class/interface/enum 动态 kind + 方法归属", () => {
    const content = [
      "public class UserService {",
      "    private int count = 0;",
      "",
      "    public User find(long id) {",
      "        return null;",
      "    }",
      "}",
      "",
      "interface Repo {",
      "    void save();",
      "}",
    ].join("\n");
    const symbols = extractSymbols("UserService.java", content);
    expect(brief(symbols)).toEqual([
      "class:UserService:L1-7",
      "method:find@UserService:L4-6",
      "interface:Repo:L9-11",
    ]);
  });

  it("Kotlin：扩展函数 parent 取接收者类型；object→class", () => {
    const content = [
      "data class User(val name: String)",
      "",
      "fun String.shout(): String {",
      "    return this.uppercase()",
      "}",
      "",
      "object Config {",
      "    fun load(): Int {",
      "        return 1",
      "    }",
      "}",
    ].join("\n");
    const symbols = extractSymbols("app.kt", content);
    expect(brief(symbols)).toEqual([
      "class:User:L1-1",
      "function:shout@String:L3-5",
      "class:Config:L7-11",
      "method:load@Config:L8-10",
    ]);
  });
});

describe("extractSymbols · 其他语言抽样", () => {
  it("Ruby：end 收编；module 容器方法归属", () => {
    const content = [
      "module Auth",
      "  def login(user)",
      "    true",
      "  end",
      "end",
      "",
      "class Session",
      "  def close",
      "    @open = false",
      "  end",
      "end",
    ].join("\n");
    const symbols = extractSymbols("auth.rb", content);
    expect(brief(symbols)).toEqual([
      "module:Auth:L1-5",
      "method:login@Auth:L2-4",
      "class:Session:L7-11",
      "method:close@Session:L8-10",
    ]);
  });

  it("Swift：protocol→interface / extension→module；C#：record→class", () => {
    const swift = ["protocol Drawable {", "    func draw()", "}", "", "struct Point {", "    func norm() -> Int {", "        return 0", "    }", "}"].join("\n");
    expect(brief(extractSymbols("p.swift", swift))).toEqual([
      "interface:Drawable:L1-3",
      "class:Point:L5-9",
      "method:norm@Point:L6-8",
    ]);
    const csharp = ["public record User(string Name);", "", "public class Repo {", "    public User Find() {", "        return null!;", "    }", "}"].join("\n");
    expect(brief(extractSymbols("r.cs", csharp))).toEqual([
      "class:User:L1-1",
      "class:Repo:L3-7",
      "method:Find@Repo:L4-6",
    ]);
  });
});

describe("extractSymbols · 边界与防护", () => {
  it("不支持的语言 / 空文件 / 无声明文件产出零符号", () => {
    expect(extractSymbols("README.md", "# hi")).toEqual([]);
    expect(extractSymbols("a.ts", "")).toEqual([]);
    expect(extractSymbols("a.ts", "// 只有注释\nconst x = 1".slice(0, 6))).toEqual([]);
  });

  it("巨型函数按 SYMBOL_MAX_LINES 截断", () => {
    const body = Array.from({ length: SYMBOL_MAX_LINES + 50 }, (_, i) => `  x${i}();`);
    const content = ["function huge() {", ...body, "}"].join("\n");
    const symbols = extractSymbols("huge.ts", content);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.endLine - symbols[0]!.startLine + 1).toBe(SYMBOL_MAX_LINES);
  });

  it("id 稳定（同位置同内容跨提取一致），签名截断 120 字符", () => {
    const content = `export function f${"a".repeat(200)}() {}`;
    const a = extractSymbols("x.ts", content);
    const b = extractSymbols("x.ts", content);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.id).toBe(makeSymbolId("x.ts", a[0]!.name, "function", 1));
    expect(a[0]!.signature.length).toBeLessThanOrEqual(121); // 120 + 省略号
  });

  it("kind 覆盖契约全集（无契约外种类产出）", () => {
    const kinds: ReadonlySet<SymbolKind> = new Set([
      "function", "class", "interface", "method", "type", "enum", "constant", "variable", "module",
    ]);
    const samples: Array<[string, string]> = [
      ["a.ts", "export function f() {}\nexport class C {}\nexport interface I {}\nexport type T = 1;\nexport enum E {}\nexport const K = 1;"],
      ["b.py", "class K:\n    def m(self):\n        pass\ndef top():\n    pass\nMAX_V = 1"],
      ["c.go", "package p\ntype S struct {}\nfunc (s S) M() {}\nfunc F() {}\nconst K = 1"],
      ["d.rs", "pub struct S {}\nimpl S { fn m() {} }\npub trait T {}\nmod u {}"],
    ];
    for (const [file, content] of samples) {
      for (const symbol of extractSymbols(file, content)) {
        expect(kinds.has(symbol.kind)).toBe(true);
      }
    }
  });
});

describe("filterSymbols", () => {
  const fixture = extractSymbols(
    "src/a.ts",
    [
      "export function loginUser() {}",
      "export function logoutUser() {}",
      "export class UserStore {",
      "  findUser() {}",
      "}",
      "export const config = 1;",
    ].join("\n")
  );

  it("name 前缀 > name 子串 > parent 子串 > 路径子串；截断 limit", () => {
    const hits = filterSymbols(fixture, "login");
    expect(hits.map((s) => s.name)).toEqual(["loginUser"]);
    const byParent = filterSymbols(fixture, "userstore");
    expect(byParent.map((s) => s.name)).toEqual(["UserStore", "findUser"]);
    const none = filterSymbols(fixture, "zzz");
    expect(none).toEqual([]);
    expect(filterSymbols(fixture, "user", 2)).toHaveLength(2);
  });

  it("空查询按名称字典序返回", () => {
    const all = filterSymbols(fixture, "");
    expect(all.map((s) => s.name)).toEqual(["config", "findUser", "loginUser", "logoutUser", "UserStore"]);
  });
});
