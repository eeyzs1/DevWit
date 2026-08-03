/**
 * Python language server 单测（v0.5.0 多语言 LSP）：
 * pythonLanguageIdFor 纯函数——扩展名识别 + 与 TS languageIdFor 互斥验证。
 * TsLanguageServer 配置 pythonLanguageIdFor 后的路由行为由 ts-server.test.ts
 * 的假 spawn 驱动测试覆盖（languageIdFor 参数化后逻辑不变）。
 */
import { describe, expect, it } from "vitest";
import { languageIdFor } from "../src/ts-server.js";
import { pythonLanguageIdFor } from "../src/pyright-server.js";

describe("pythonLanguageIdFor", () => {
  it(".py → python", () => {
    expect(pythonLanguageIdFor("test.py")).toBe("python");
    expect(pythonLanguageIdFor("src/main.py")).toBe("python");
    expect(pythonLanguageIdFor("a/b/c/script.py")).toBe("python");
    expect(pythonLanguageIdFor("D:\\proj\\app.py")).toBe("python");
  });

  it("大小写不敏感", () => {
    expect(pythonLanguageIdFor("test.PY")).toBe("python");
    expect(pythonLanguageIdFor("test.Py")).toBe("python");
    expect(pythonLanguageIdFor("test.pY")).toBe("python");
  });

  it("非 Python 文件 → null", () => {
    expect(pythonLanguageIdFor("test.ts")).toBeNull();
    expect(pythonLanguageIdFor("test.js")).toBeNull();
    expect(pythonLanguageIdFor("test.rs")).toBeNull();
    expect(pythonLanguageIdFor("test.go")).toBeNull();
    expect(pythonLanguageIdFor("noext")).toBeNull();
    expect(pythonLanguageIdFor("")).toBeNull();
    expect(pythonLanguageIdFor("pyfile")).toBeNull();
  });

  it("无扩展名或仅点 → null（path.extname 对点开头文件名返回空，POSIX 规则）", () => {
    // ".py" 是隐藏文件名（无扩展名），非 Python 文件——path.extname(".py") === ""
    expect(pythonLanguageIdFor(".py")).toBeNull();
    expect(pythonLanguageIdFor(".")).toBeNull();
    expect(pythonLanguageIdFor("file.")).toBeNull();
  });
});

describe("TS/Python languageIdFor 互斥", () => {
  const pyFiles = ["test.py", "main.PY", "script.Py"];
  const tsFiles = ["test.ts", "test.tsx", "test.js", "test.jsx", "test.mts", "test.cts", "test.mjs", "test.cjs"];

  it("Python 文件被 pythonLanguageIdFor 接受、被 TS languageIdFor 拒绝", () => {
    for (const f of pyFiles) {
      expect(pythonLanguageIdFor(f)).toBe("python");
      expect(languageIdFor(f)).toBeNull();
    }
  });

  it("TS/JS 文件被 TS languageIdFor 接受、被 pythonLanguageIdFor 拒绝", () => {
    for (const f of tsFiles) {
      expect(languageIdFor(f)).not.toBeNull();
      expect(pythonLanguageIdFor(f)).toBeNull();
    }
  });

  it("LspService 路由逻辑：.py → pyServer，其余 → tsServer（file.toLowerCase().endsWith('.py') 判定）", () => {
    // 模拟 LspService.serverFor 的路由逻辑
    const routeTo = (file: string): "py" | "ts" =>
      file.toLowerCase().endsWith(".py") ? "py" : "ts";

    expect(routeTo("test.py")).toBe("py");
    expect(routeTo("TEST.PY")).toBe("py");
    expect(routeTo("src/main.py")).toBe("py");
    expect(routeTo("test.ts")).toBe("ts");
    expect(routeTo("test.js")).toBe("ts");
    expect(routeTo("test.rs")).toBe("ts");
    expect(routeTo("README.md")).toBe("ts");
    expect(routeTo("noext")).toBe("ts");
  });
});
