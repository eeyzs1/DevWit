#!/usr/bin/env python3
"""
SCAN-SECRET-LEAK: 扫描 DevWit 项目树中的明文 LLM API key 泄漏（对应 AR005 凭证加密）。

匹配模式：
1. sk-ant-[A-Za-z0-9-]{20,}      Anthropic API key
2. sk-proj-[A-Za-z0-9-]{20,}     OpenAI project key
3. sk-[A-Za-z0-9]{32,}           通用 sk- 密钥
4. x-api-key 头赋值的字符串字面量
5. api[_-]?key 赋值的 sk- 开头字符串字面量

排除：node_modules/、.git/、dist/、out/、package-lock.json、二进制扩展名文件。

用法：
    python verification/scan-secret-leak.py --project-root <dir>

exit 0 = 未发现明文密钥
exit 1 = 发现泄漏，逐条打印 文件:行号
"""

import argparse
import re
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SECRET_PATTERNS = [
    ("anthropic_api_key", re.compile(r"sk-ant-[A-Za-z0-9-]{20,}")),
    ("openai_project_key", re.compile(r"sk-proj-[A-Za-z0-9-]{20,}")),
    ("generic_llm_api_key", re.compile(r"sk-[A-Za-z0-9]{32,}")),
    ("x_api_key_header", re.compile(r"x-api-key\s*[:=]\s*['\"][^'\"]+['\"]")),
    ("plaintext_api_key_assign", re.compile(r"api[_-]?key\s*[:=]\s*['\"]sk-[^'\"]+['\"]", re.IGNORECASE)),
]

EXCLUDED_DIRS = {"node_modules", ".git", "dist", "out"}
EXCLUDED_FILES = {"package-lock.json"}
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns",
    ".exe", ".dll", ".node", ".wasm", ".woff", ".woff2", ".ttf", ".otf",
    ".zip", ".gz", ".7z", ".pdf",
}
MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024


def iter_text_files(project_root):
    for path in sorted(project_root.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(project_root).parts
        if any(part in EXCLUDED_DIRS for part in rel_parts):
            continue
        if path.name in EXCLUDED_FILES or path.suffix.lower() in BINARY_EXTENSIONS:
            continue
        try:
            if path.stat().st_size > MAX_FILE_SIZE_BYTES:
                continue
        except OSError:
            continue
        yield path


def main():
    parser = argparse.ArgumentParser(description="扫描项目树中的明文 LLM API key 泄漏（AR005）")
    parser.add_argument("--project-root", required=True, help="待扫描的项目根目录")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        print(f"ERROR: 项目根目录不存在: {project_root}")
        return 1

    findings = []
    scanned = 0
    for path in iter_text_files(project_root):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        scanned += 1
        for lineno, line in enumerate(lines, start=1):
            for name, pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    findings.append(f"{path.relative_to(project_root)}:{lineno} [{name}] 发现明文密钥")
                    break

    if findings:
        print(f"FAIL: 发现 {len(findings)} 处明文密钥泄漏（AR005：API key 必须经 safeStorage 加密，禁明文落盘/进日志）")
        for f in findings:
            print("  " + f)
        return 1
    print(f"PASS: 扫描 {scanned} 个文本文件，未发现明文密钥")
    return 0


if __name__ == "__main__":
    sys.exit(main())
