#!/usr/bin/env python3
"""
CHECK-ARCHITECTURE-BOUNDARIES: 校验 DevWit 产品代码的依赖方向是否符合
constraints/architecture-rules.yaml 中 dependency_direction.forbidden。

检查内容（对应 AR001-AR004）：
1. 包间依赖：如 editor-core/editor-render/syntax import agent-runtime|chat-ui|modes|llm-providers（AR003），
   packages/* import apps/*，llm-providers import agent-runtime（AR002 反向依赖）。
2. 渲染进程边界：packages/chat-ui、packages/editor-render、apps/desktop 渲染层文件
   import node:fs/node:child_process（AR001）或主进程服务包 workspace/terminal/settings（AR004）。
3. LLM 出口唯一：packages/llm-providers 之外的文件出现指向 api.anthropic.com / api.openai.com
   的 LLM HTTP 调用（AR002）。

用法：
    python verification/check-architecture-boundaries.py --project-root <dir>
    python verification/check-architecture-boundaries.py --project-root . --rules constraints/architecture-rules.yaml

exit 0 = PASS（或产品源码目录尚不存在，打印 SKIP 不阻断早期开发）
exit 1 = FAIL（发现违规，逐条打印 文件:行号 + 规则 id）
"""

import argparse
import re
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

IMPORT_RE = re.compile(
    r"(?:import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?"
    r"|export\s+(?:[\w*{}\s,]+\s+from\s+)"
    r"|require\s*\(\s*"
    r"|import\s*\(\s*)"
    r"['\"]([^'\"]+)['\"]"
)
LLM_HTTP_RE = re.compile(r"api\.anthropic\.com|api\.openai\.com")
TS_EXTENSIONS = {".ts", ".tsx"}
SKIP_DIRS = {"node_modules", "dist", "out", ".git", "release", "coverage"}
RENDERER_PACKAGES = {"chat-ui", "editor-render"}
NODE_BUILTIN_MAP = {"node:fs": {"node:fs", "fs"}, "node:child_process": {"node:child_process", "child_process"}}


def parse_direction(entry):
    parts = re.split(r"\s*(?:→|->)\s*", str(entry).strip())
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1]


def load_dependency_direction(rules_path):
    text = Path(rules_path).read_text(encoding="utf-8")
    try:
        import yaml  # 可选依赖：优先用 PyYAML
        data = yaml.safe_load(text)
        dd = (data or {}).get("dependency_direction", {}) or {}
        forbidden = [parse_direction(e) for e in dd.get("forbidden", []) or []]
        return [d for d in forbidden if d]
    except ImportError:
        pass
    # 无 PyYAML 时的最小解析：定位 dependency_direction 块内 forbidden: 小节下的 "- \"A → B\"" 行
    forbidden, section, subsection = [], None, None
    for line in text.splitlines():
        stripped = line.strip()
        if re.match(r"^dependency_direction:", line):
            section = "dd"
            continue
        if section == "dd" and line and not line.startswith((" ", "\t")):
            section = None
        if section == "dd":
            if stripped.startswith("forbidden:"):
                subsection = "forbidden"
                continue
            if stripped.startswith("allowed:"):
                subsection = "allowed"
                continue
            if subsection == "forbidden" and stripped.startswith("- "):
                value = stripped[2:].strip().strip('"').strip("'")
                parsed = parse_direction(value)
                if parsed:
                    forbidden.append(parsed)
    return forbidden


def rule_id_for(src_pattern, tgt_pattern):
    if src_pattern == "renderer" and tgt_pattern in NODE_BUILTIN_MAP:
        return "AR001"
    if tgt_pattern == "llm-http" or src_pattern == "llm-providers":
        return "AR002"
    if src_pattern in {"editor-core", "editor-render", "syntax"}:
        return "AR003"
    if src_pattern == "renderer" and tgt_pattern in {"workspace", "terminal", "settings"}:
        return "AR004"
    return "AR-DEP"


def discover_modules(project_root):
    modules = {}
    for root_name in ("packages", "apps"):
        root = project_root / root_name
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    modules[child.name] = root_name
    return modules


def file_identity(rel_path):
    parts = rel_path.parts
    if len(parts) >= 2 and parts[0] in ("packages", "apps"):
        return parts[1], parts[0]
    return None, None


def is_renderer_file(rel_path):
    parts = rel_path.parts
    if len(parts) >= 2 and parts[0] == "packages" and parts[1] in RENDERER_PACKAGES:
        return True
    if parts[0] == "apps" and "renderer" in parts[2:]:
        return True
    return False


def match_source(pattern, module, root, renderer):
    if pattern in ("*", "any"):
        return True
    if pattern == "renderer":
        return renderer
    if pattern == "packages/*":
        return root == "packages"
    if pattern == "apps/*":
        return root == "apps"
    return pattern == module


def resolve_specifier(spec, file_path, project_root, modules):
    if spec.startswith("."):
        target = (file_path.parent / spec).resolve()
        try:
            rel = target.relative_to(project_root)
        except ValueError:
            return None, None
        return file_identity(rel)
    for name, root in modules.items():
        if spec == name or spec.endswith("/" + name) or ("/" + name + "/") in spec or spec.startswith(name + "/"):
            return name, root
    return None, None


def match_target(pattern, target_module, target_root):
    if pattern == "packages/*":
        return target_root == "packages"
    if pattern == "apps/*":
        return target_root == "apps"
    if pattern == "*":
        return target_module is not None
    return pattern == target_module


def iter_ts_files(project_root):
    for root_name in ("packages", "apps"):
        root = project_root / root_name
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix in TS_EXTENSIONS and path.is_file():
                if not any(part in SKIP_DIRS for part in path.parts):
                    yield path


def scan(project_root, forbidden):
    modules = discover_modules(project_root)
    violations = []
    for file_path in iter_ts_files(project_root):
        rel = file_path.relative_to(project_root)
        module, root = file_identity(rel)
        renderer = is_renderer_file(rel)
        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for lineno, line in enumerate(lines, start=1):
            for src_pat, tgt_pat in forbidden:
                if not match_source(src_pat, module, root, renderer):
                    continue
                rid = rule_id_for(src_pat, tgt_pat)
                if tgt_pat == "llm-http":
                    # AR002：仅 packages/llm-providers 允许出现 LLM endpoint
                    if module != "llm-providers" and LLM_HTTP_RE.search(line):
                        violations.append(
                            f"{rel}:{lineno} [{rid}] 非 llm-providers 包出现 LLM HTTP 调用（{line.strip()[:120]}）"
                        )
                    continue
                if tgt_pat in NODE_BUILTIN_MAP:
                    specifiers = IMPORT_RE.findall(line)
                    if any(spec in NODE_BUILTIN_MAP[tgt_pat] for spec in specifiers):
                        violations.append(
                            f"{rel}:{lineno} [{rid}] 渲染进程代码 import {tgt_pat}（{line.strip()[:120]}）"
                        )
                    continue
                for spec in IMPORT_RE.findall(line):
                    if spec in ("fs", "node:fs", "child_process", "node:child_process"):
                        continue  # node 内置由 renderer→node:* 规则处理
                    tgt_module, tgt_root = resolve_specifier(spec, file_path.resolve(), project_root, modules)
                    if tgt_module is None or tgt_module == module:
                        continue
                    if match_target(tgt_pat, tgt_module, tgt_root):
                        violations.append(
                            f"{rel}:{lineno} [{rid}] 禁止依赖 {src_pat} → {tgt_pat}：import '{spec}'"
                        )
    return violations


def main():
    parser = argparse.ArgumentParser(
        description="校验 DevWit apps/ 与 packages/ 下 TS 源码的 import 依赖方向是否符合 architecture-rules.yaml 的 forbidden 规则"
    )
    parser.add_argument("--project-root", required=True, help="产品代码根目录（含 apps/ 与 packages/）")
    parser.add_argument(
        "--rules",
        default=None,
        help="architecture-rules.yaml 路径（默认 harness 根下 constraints/architecture-rules.yaml）",
    )
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    harness_root = Path(__file__).resolve().parent.parent
    rules_path = Path(args.rules).resolve() if args.rules else harness_root / "constraints" / "architecture-rules.yaml"

    if not rules_path.is_file():
        print(f"ERROR: 规则文件不存在: {rules_path}")
        return 1

    if not (project_root / "packages").is_dir() and not (project_root / "apps").is_dir():
        print(f"SKIP: {project_root} 下不存在 apps/ 或 packages/ 源码目录（产品未开发），架构边界检查跳过")
        return 0

    forbidden = load_dependency_direction(rules_path)
    if not forbidden:
        print(f"ERROR: {rules_path} 的 dependency_direction.forbidden 为空或不可解析")
        return 1

    ts_files = list(iter_ts_files(project_root))
    if not ts_files:
        print("SKIP: apps/ 与 packages/ 下暂无 .ts/.tsx 源文件，架构边界检查跳过")
        return 0

    violations = scan(project_root, forbidden)
    if violations:
        print(f"FAIL: 发现 {len(violations)} 处架构边界违规（rules: {rules_path}）")
        for v in violations:
            print("  " + v)
        return 1
    print(f"PASS: 扫描 {len(ts_files)} 个 TS 文件，未发现 forbidden 依赖违规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
