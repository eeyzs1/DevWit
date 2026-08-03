/**
 * Python language server 支持（v0.5.0 多语言 LSP）。
 *
 * pyright 是 Microsoft 的 Python type checker + language server，遵循标准 LSP 协议。
 * 通过 `pyright-langserver.js --stdio` 启动，与 TsLanguageServer 共享 LspClient 基础设施。
 * TsLanguageServer 的 languageIdFor 可配置参数使其可复用于 Python——零重复代码。
 */
import path from "node:path";

/** Python 文件扩展名 → LSP languageId（.py → "python"；其余返回 null 不同步）。 */
export function pythonLanguageIdFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".py" ? "python" : null;
}
