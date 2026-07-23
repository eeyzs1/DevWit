#!/usr/bin/env python3
"""
Meta-Harness Validator: 校验 LLM 填充后的 harness 是否合格

读 harness-scaffold.yaml，对照检查：
  1. 结构完整：所有必填层在、通用原语在、evolution 三件套在、anti-mock 在
  2. Slot 已填充：每个 LLM slot 的当前哈希 != baseline_hash（LLM 改过）
  3. Slot 非空且语法合法（YAML 可解析 / 非空）
  4. 可追溯：task 的每条 acceptance_criteria 在某 slot 里有对应验证手段
  5. 反 mock：扫描 slot 内容，无 mock/fake/stub/simulated 模式
  6. 引用一致性：slot 引用的组件名在 task 里存在（启发式）

退出码：0 = PASS，1 = FAIL（含 report）

Usage:
    python scripts/validate-harness.py <harness_dir>
"""

import hashlib
import re
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 必填层（scaffold 总会创建）
REQUIRED_LAYERS = ["context", "tools", "memory", "planning", "verification",
                   "feedback", "constraints", "evolution"]

# 通用原语（必须存在，scaffold 总会复制）
REQUIRED_UNIVERSAL = [
    "guard.py", "orchestrator.py",
    "context/loader.py",
    "planning/dag-builder.py",
    "planning/dispatcher.py",
    "planning/task-card-schema.yaml",
    "verification/self-check.py",
    "verification/consistency-check.py",
    "verification/anti-mock-check.py",
    "verification/quality-gate.py",
    "verification/dispatch-verifier.py",
    "verification/hook-executor.py",
    "verification/runtime-hooks.yaml",
    "verification/audit-append.py",
    "verification/lint-check.py",
    "evolution/framework.md",
    # Runtime layer 通用原语（v2.6+）——多 worktree 并发基础设施
    "runtime/supervisor.py",
    "runtime/worktree_lifecycle.py",
    "runtime/leaf_protocol.py",
    "runtime/leaf_prepare.py",
    "runtime/leaf_record.py",
    "runtime/event_stream.py",
    "runtime/rebase_sync.py",
    "runtime/workitem_source.py",
    # evolution/genome.yaml 和 evolution/log.yaml 是 LLM slot（在 LLM_SLOTS 里），
    # 由 check #2（slot enrichment）校验存在 + hash 改过，不在这里重复校验。
]

# 反 mock 模式（slot 内容里禁止出现生产代码 mock）
MOCK_PATTERNS = [
    r"\bmock_\w+",
    r"\bMock\w+",
    r"\bfake_\w+",
    r"\bFake\w+",
    r"\bstub_\w+",
    r"\bStub\w+",
    r"\bsimulated\s+return",
    r"#\s*TODO",
    r"#\s*placeholder",
    r"\bexample_only\b",
]

# 可验证性关键词（acceptance_criteria 应在某 slot 出现相关验证手段）
VERIFICATION_SLOT_FILES = [
    "verification/security-guardrails.yaml",
    "verification/self-check.py",
    "constraints/architecture-rules.yaml",
    "constraints/cost-budget.yaml",
    "planning/budget.yaml",
]


def file_hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def load_yaml(path: Path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        return f"__PARSE_ERROR__: {e}"


def validate(harness_dir: Path) -> tuple:
    """返回 (passed, report_lines)"""
    report = []
    errors = []
    warnings = []

    manifest_file = harness_dir / "harness-scaffold.yaml"
    if not manifest_file.exists():
        return False, [f"FATAL: {manifest_file} not found — not a scaffolded harness dir"]

    manifest = load_yaml(manifest_file) or {}
    task_file = harness_dir / manifest.get("task_file", "task.yaml")
    task = load_yaml(task_file) or {}

    report.append(f"=== Harness Validation Report ===")
    report.append(f"Dir: {harness_dir}")
    report.append(f"Task: {task.get('name', '?')}  Domain: {task.get('domain', '?')}")
    report.append("")

    # 1. 结构完整
    report.append("[1] Structure completeness")
    for layer in REQUIRED_LAYERS:
        if not (harness_dir / layer).is_dir():
            errors.append(f"  MISSING layer dir: {layer}/")
    for prim in REQUIRED_UNIVERSAL:
        if not (harness_dir / prim).exists():
            errors.append(f"  MISSING universal primitive: {prim}")
    if not errors:
        report.append("  PASS — all required layers and universal primitives present")
    else:
        for e in errors[:10]:
            report.append(e)
    report.append("")

    # 2 & 3. Slot 已填充 + 语法合法
    report.append("[2] LLM slot enrichment")
    slots = manifest.get("llm_slots", [])
    enriched = 0
    slot_errors = []
    for slot in slots:
        rel = slot["file"]
        fpath = harness_dir / rel
        if not fpath.exists():
            slot_errors.append(f"  MISSING slot file: {rel}")
            continue
        current_hash = file_hash(fpath)
        if current_hash == slot["baseline_hash"]:
            slot_errors.append(f"  NOT ENRICHED (hash == baseline): {rel} — LLM did not modify this slot")
            continue
        # 语法检查
        if fpath.suffix in (".yaml", ".yml"):
            content = fpath.read_text(encoding="utf-8").strip()
            if not content:
                slot_errors.append(f"  EMPTY slot: {rel}")
                continue
            parsed = load_yaml(fpath)
            if isinstance(parsed, str) and str(parsed).startswith("__PARSE_ERROR__"):
                slot_errors.append(f"  YAML PARSE ERROR in {rel}: {parsed}")
                continue
        enriched += 1
    if slot_errors:
        for e in slot_errors:
            report.append(e)
            errors.append(e)
    report.append(f"  Enriched: {enriched}/{len(slots)} slots")
    report.append("")

    # 4. 可追溯：acceptance_criteria 应在某 verification slot 出现
    report.append("[3] Acceptance criteria traceability")
    acs = task.get("acceptance_criteria", [])
    if not acs:
        warnings.append("  task.acceptance_criteria is empty — cannot verify traceability")
        report.append("  WARN — no acceptance_criteria in task.yaml")
    else:
        # 收集所有 verification slot 的文本
        vtext = ""
        for vf in VERIFICATION_SLOT_FILES:
            p = harness_dir / vf
            if p.exists():
                vtext += "\n" + p.read_text(encoding="utf-8").lower()
        # 启发式：每条 ac 的关键词应在某 verification slot 出现
        ac_keywords = []
        for ac in acs:
            # 提取 3+ 字母词
            words = re.findall(r"[a-z_]{4,}", str(ac).lower())
            ac_keywords.append((str(ac), words))
        missing = []
        for ac, words in ac_keywords:
            if not words:
                continue
            hit = any(w in vtext for w in words)
            if not hit:
                missing.append(ac)
        if missing:
            for m in missing[:5]:
                msg = f"  NO VERIFIER REFERENCE for criterion: {m[:80]}"
                report.append(msg)
                warnings.append(msg)
            report.append(f"  Traceable: {len(acs)-len(missing)}/{len(acs)} criteria")
        else:
            report.append(f"  PASS — all {len(acs)} criteria have verifier references")
    report.append("")

    # 5. 反 mock
    report.append("[4] Anti-mock scan (enriched slots)")
    mock_hits = []
    for slot in slots:
        rel = slot["file"]
        fpath = harness_dir / rel
        if not fpath.exists():
            continue
        if file_hash(fpath) == slot["baseline_hash"]:
            continue  # 未改的不扫
        text = fpath.read_text(encoding="utf-8")
        for pat in MOCK_PATTERNS:
            for m in re.finditer(pat, text):
                line_no = text[:m.start()].count("\n") + 1
                mock_hits.append(f"  {rel}:{line_no}  pattern='{pat}' match='{m.group(0)}'")
    if mock_hits:
        for h in mock_hits[:15]:
            report.append(h)
            errors.append(h)
        report.append(f"  FAIL — {len(mock_hits)} mock/placeholder patterns found")
    else:
        report.append("  PASS — no mock/fake/stub/placeholder patterns in enriched slots")
    report.append("")

    # 6. 引用一致性：architecture-rules 的 dependency_direction 引用应合理
    report.append("[5] Reference sanity (architecture-rules dependency_direction)")
    ar_file = harness_dir / "constraints" / "architecture-rules.yaml"
    if ar_file.exists():
        ar = load_yaml(ar_file)
        if isinstance(ar, dict):
            dd = ar.get("dependency_direction", {})
            allowed = dd.get("allowed", []) + dd.get("forbidden", [])
            if not allowed:
                warnings.append("  architecture-rules.dependency_direction is empty")
                report.append("  WARN — dependency_direction empty")
            else:
                report.append(f"  PASS — {len(allowed)} dependency rules defined")
                # 检查是否还是 web-app 默认（frontend→api→service→repo→DB）
                joined = " ".join(allowed).lower()
                if "frontend" in joined and "api" in joined and "repository" in joined:
                    # 可能是未改的 web-app seed 基线
                    msg = ("  WARN — dependency_direction still looks like generic web-app baseline "
                           "(frontend/api/repository). If task is NOT a web-app, LLM did not customize.")
                    report.append(msg)
                    warnings.append(msg)
        else:
            report.append("  SKIP — architecture-rules.yaml not a valid dict")
    else:
        report.append("  SKIP — architecture-rules.yaml not present")
    report.append("")

    # 7. work-units.yaml DAG 校验（无环 + assigned_to 与 prototypes 一致）
    report.append("[6] Work-units DAG + dispatcher consistency")
    wu_file = harness_dir / "planning" / "work-units.yaml"
    proto_file = harness_dir / "planning" / "sub-agent-dispatch.yaml"
    if not wu_file.exists():
        msg = f"  MISSING planning/work-units.yaml — dispatcher cannot build DAG"
        report.append(msg)
        errors.append(msg)
    elif not proto_file.exists():
        msg = f"  MISSING planning/sub-agent-dispatch.yaml"
        report.append(msg)
        errors.append(msg)
    else:
        wu_data = load_yaml(wu_file)
        proto_data = load_yaml(proto_file)
        if isinstance(wu_data, dict) and isinstance(proto_data, dict):
            units = wu_data.get("work_units") or wu_data.get("units") or []
            protos = proto_data.get("prototypes") or {}
            proto_names = set(protos.keys())
            wu_ids = {u.get("id") for u in units if isinstance(u, dict)}
            # 7a. 字段完整
            field_errs = []
            for u in units:
                if not isinstance(u, dict):
                    continue
                uid = u.get("id", "?")
                for fld in ("id", "name", "depends_on", "assigned_to", "success_criteria"):
                    # depends_on 允许为空列表（无依赖是合法声明）
                    if fld == "depends_on":
                        if fld not in u or u[fld] is None:
                            field_errs.append(f"  work_unit {uid} missing field: {fld}")
                    elif fld not in u or u[fld] in (None, "", []):
                        field_errs.append(f"  work_unit {uid} missing/empty field: {fld}")
                if u.get("assigned_to") and u["assigned_to"] not in proto_names:
                    field_errs.append(
                        f"  work_unit {uid} assigned_to='{u['assigned_to']}' "
                        f"not in sub-agent-dispatch prototypes {sorted(proto_names)}"
                    )
            # 7b. depends_on 引用已存在 unit
            dep_errs = []
            for u in units:
                if not isinstance(u, dict):
                    continue
                for dep in u.get("depends_on") or []:
                    if dep not in wu_ids:
                        dep_errs.append(f"  work_unit {u.get('id','?')} depends_on unknown id: {dep}")
            # 7c. DAG 无环（Kahn）
            cycle_err = ""
            if units and not field_errs and not dep_errs:
                try:
                    import importlib.util
                    spec = importlib.util.spec_from_file_location(
                        "dag_builder", harness_dir / "planning" / "dag-builder.py")
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    cycle = mod.detect_cycle([
                        {"id": u["id"], "depends_on": list(u.get("depends_on") or [])}
                        for u in units if isinstance(u, dict)
                    ])
                    if cycle:
                        cycle_err = f"  CYCLE detected in work-units DAG: {' -> '.join(cycle)}"
                except Exception as e:
                    cycle_err = f"  WARN — could not run dag-builder.cycle check: {e}"
            for e in field_errs + dep_errs:
                report.append(e)
                errors.append(e)
            if cycle_err:
                report.append(cycle_err)
                errors.append(cycle_err)
            if not (field_errs or dep_errs or cycle_err):
                # 7d. workflow 名一致性：work_unit.workflow 必须存在于 flow-control.yaml
                fc_data = load_yaml(harness_dir / "planning" / "flow-control.yaml")
                wf_errs = []
                if isinstance(fc_data, dict):
                    fc_workflows = set((fc_data.get("workflows") or {}).keys())
                    wu_workflows = set()
                    for u in units:
                        if not isinstance(u, dict):
                            continue
                        wf = u.get("workflow")
                        if wf:
                            wu_workflows.add(wf)
                    missing = wu_workflows - fc_workflows
                    if missing:
                        wf_errs.append(
                            f"  work_units reference workflows not defined in flow-control.yaml: "
                            f"{sorted(missing)}"
                        )
                if wf_errs:
                    for e in wf_errs:
                        report.append(e)
                        errors.append(e)
                else:
                    report.append(
                        f"  PASS — {len(units)} work_units, "
                        f"{len(proto_names)} prototypes, DAG acyclic, all assigned_to valid, "
                        f"all workflows exist in flow-control.yaml"
                    )
        else:
            msg = "  SKIP — work-units.yaml or sub-agent-dispatch.yaml not parseable"
            report.append(msg)
            warnings.append(msg)
    report.append("")

    # 7. 脚本引用完整性——runtime-hooks + flow-control 引用的 .py 必须存在
    report.append("[7] Script reference integrity (runtime-hooks + flow-control)")
    import re as _re
    script_re = _re.compile(r"python\s+([a-zA-Z0-9_./\-]+\.py)")
    referenced = set()

    # runtime-hooks.yaml: 遍历 events.*.checks[].command
    hooks_file = harness_dir / "verification" / "runtime-hooks.yaml"
    if hooks_file.exists():
        hooks = load_yaml(hooks_file)
        if isinstance(hooks, dict):
            for event in (hooks.get("events") or {}).values():
                if not isinstance(event, dict):
                    continue
                for check in event.get("checks", []) or []:
                    cmd = check.get("command", "") if isinstance(check, dict) else ""
                    referenced.update(script_re.findall(cmd))

    # flow-control.yaml: workflows.*.steps[].command + mandatory_pre_steps[].command
    fc_file = harness_dir / "planning" / "flow-control.yaml"
    if fc_file.exists():
        fc = load_yaml(fc_file)
        if isinstance(fc, dict):
            for wf in (fc.get("workflows") or {}).values():
                if not isinstance(wf, dict):
                    continue
                for step in wf.get("steps", []) or []:
                    cmd = step.get("command", "") if isinstance(step, dict) else ""
                    referenced.update(script_re.findall(cmd))
                for pre in wf.get("mandatory_pre_steps", []) or []:
                    cmd = pre.get("command", "") if isinstance(pre, dict) else ""
                    referenced.update(script_re.findall(cmd))

    # 通用原语缺失由 check #1 管；check #7 只报项目特定脚本的悬空引用
    universal_set = {p for p in REQUIRED_UNIVERSAL}
    dangling = []
    for ref in sorted(referenced):
        if ref in universal_set:
            continue  # check #1 handles universal primitives
        if not (harness_dir / ref).exists():
            dangling.append(ref)
    if dangling:
        for r in dangling:
            msg = f"  DANGLING script ref: '{r}' referenced in runtime-hooks/flow-control but not generated"
            report.append(msg)
            warnings.append(msg)
        report.append(f"  {len(dangling)} project-specific script refs missing (LLM should generate them)")
    else:
        report.append(f"  PASS — all {len(referenced)} referenced scripts exist (or are universal primitives)")
    report.append("")

    # 8. fixer-registry handler integrity——每条 handler 指向的 .py 必须存在
    #    registry 缺失/不可解析/handler 悬空 = ERROR（阻断 GENERATE→FACTORY）
    #    因为 apply_fixes 经 importlib 调 handler，缺失会 runtime FileNotFoundError
    report.append("[8] Fixer-registry handler integrity")
    registry_file = harness_dir / "feedback" / "fixer-registry.yaml"
    if not registry_file.exists():
        msg = "  MISSING feedback/fixer-registry.yaml — apply_fixes cannot dispatch fixes"
        report.append(msg)
        errors.append(msg)
    else:
        registry = load_yaml(registry_file)
        if isinstance(registry, str) and str(registry).startswith("__PARSE_ERROR__"):
            msg = f"  YAML PARSE ERROR in feedback/fixer-registry.yaml: {registry}"
            report.append(msg)
            errors.append(msg)
        elif not isinstance(registry, dict):
            msg = "  feedback/fixer-registry.yaml not a valid dict"
            report.append(msg)
            errors.append(msg)
        else:
            fixers = registry.get("fixers") or {}
            if not isinstance(fixers, dict):
                msg = "  fixer-registry.fixers not a dict — no fixers bound"
                report.append(msg)
                errors.append(msg)
            elif not fixers:
                msg = "  WARN — fixer-registry.fixers is empty (no fixers bound, apply_fixes will fully defer to manual)"
                report.append(msg)
                warnings.append(msg)
            else:
                missing_handlers = []
                for fixer_name, cfg in fixers.items():
                    if not isinstance(cfg, dict):
                        msg = f"  fixer '{fixer_name}' cfg not a dict — skip"
                        report.append(msg)
                        warnings.append(msg)
                        continue
                    handler = cfg.get("handler")
                    if not handler:
                        msg = f"  fixer '{fixer_name}' missing 'handler' field"
                        report.append(msg)
                        errors.append(msg)
                        continue
                    if not (harness_dir / handler).exists():
                        missing_handlers.append((fixer_name, handler))
                if missing_handlers:
                    for name, h in missing_handlers:
                        msg = (f"  MISSING fixer handler: fixer='{name}' handler='{h}' "
                               f"— apply_fixes will FileNotFoundError at runtime")
                        report.append(msg)
                        errors.append(msg)
                    report.append(f"  FAIL — {len(missing_handlers)} fixer handler(s) missing")
                else:
                    report.append(f"  PASS — {len(fixers)} fixer(s) registered, all handler paths exist")
    report.append("")

    # 9. Runtime layer 完整性（v2.6+）——supervisor/worktree/workitem-source/doc contract
    #    - check #9a: runtime-config.yaml 存在且 supervisor 配置合理
    #    - check #9b: workitem-source.yaml 存在 + adapter 实现存在 + 接口实现完整
    #    - check #9c: merge-policy.yaml 与 criticality 一致（C>=4 必须 rebase_only）
    #    - check #9d: agent-protocol.yaml 的 role 与 sub-agent-dispatch prototypes 一致
    #    - check #9e: doc contracts 存在 + 含 evolution 字段
    report.append("[9] Runtime layer integrity (supervisor + worktree + workitem-source + docs)")
    profile = manifest.get("profile") or {}
    scope = profile.get("scope", 3)
    criticality = profile.get("criticality", 3)

    # 9a. runtime-config.yaml
    rc_file = harness_dir / "planning" / "runtime-config.yaml"
    if scope < 3:
        # scope<3 不强制 runtime-config（gate 过滤掉了）
        report.append("  SKIP — scope<3, runtime-config gated out (single-session mode)")
    elif not rc_file.exists():
        msg = "  MISSING planning/runtime-config.yaml — supervisor cannot run"
        report.append(msg)
        errors.append(msg)
    else:
        rc = load_yaml(rc_file)
        if isinstance(rc, dict):
            sup = rc.get("supervisor") or {}
            if sup.get("enabled"):
                if not rc.get("stop_conditions"):
                    msg = "  runtime-config.stop_conditions empty — supervisor has no stop condition"
                    report.append(msg)
                    errors.append(msg)
                else:
                    report.append(f"  PASS — runtime-config: supervisor.enabled, "
                                 f"{len(rc['stop_conditions'])} stop conditions")
            else:
                report.append("  PASS — runtime-config: supervisor.disabled (single-session)")
        else:
            msg = "  runtime-config.yaml not a valid dict"
            report.append(msg)
            errors.append(msg)

    # 9b. workitem-source.yaml + adapter 实现
    ws_file = harness_dir / "planning" / "workitem-source.yaml"
    if not ws_file.exists():
        msg = "  MISSING planning/workitem-source.yaml — supervisor cannot dispatch"
        report.append(msg)
        errors.append(msg)
    else:
        ws = load_yaml(ws_file)
        if isinstance(ws, dict):
            adapter = ws.get("adapter")
            class_name = ws.get("class_name")
            if not adapter or not class_name:
                msg = "  workitem-source.yaml missing 'adapter' or 'class_name'"
                report.append(msg)
                errors.append(msg)
            else:
                # 校验 adapter 实现存在
                adapter_path = harness_dir / "runtime" / "sources" / f"{adapter}_source.py"
                if not adapter_path.exists():
                    msg = (f"  MISSING adapter impl: runtime/sources/{adapter}_source.py — "
                           f"LLM did not generate workitem source adapter")
                    report.append(msg)
                    errors.append(msg)
                else:
                    # 校验 adapter 实现了所有抽象方法（importlib 加载）
                    interface_errs = []
                    try:
                        import importlib.util
                        import types as _types
                        # 先加载基类
                        base_spec = importlib.util.spec_from_file_location(
                            "workitem_source_base",
                            harness_dir / "runtime" / "workitem_source.py")
                        base_mod = importlib.util.module_from_spec(base_spec)
                        base_spec.loader.exec_module(base_mod)
                        # 加载 adapter
                        adapter_spec = importlib.util.spec_from_file_location(
                            f"adapter_{adapter}", adapter_path)
                        adapter_mod = importlib.util.module_from_spec(adapter_spec)
                        # 注入基类到 sys.modules（adapter 文件可能 `from runtime.workitem_source import ...`）
                        import sys as _sys
                        if "runtime" not in _sys.modules:
                            _sys.modules["runtime"] = _types.ModuleType("runtime")
                        _sys.modules["runtime"].workitem_source = base_mod
                        _sys.modules["runtime.workitem_source"] = base_mod
                        adapter_spec.loader.exec_module(adapter_mod)
                        cls = getattr(adapter_mod, class_name, None)
                        if cls is None:
                            interface_errs.append(f"class {class_name} not found in {adapter}_source.py")
                        elif not issubclass(cls, base_mod.WorkitemSource):
                            interface_errs.append(f"{class_name} does not inherit WorkitemSource")
                        else:
                            # 校验抽象方法都被实现
                            abstract_methods = {
                                "claim_next", "fetch_brief", "update_status", "archive"
                            }
                            for m in abstract_methods:
                                method = getattr(cls, m, None)
                                if method is None:
                                    interface_errs.append(f"{class_name}.{m} missing")
                                elif getattr(method, "__isabstractmethod__", False):
                                    interface_errs.append(f"{class_name}.{m} still abstract (not implemented)")
                    except Exception as e:
                        interface_errs.append(f"cannot load adapter: {e}")
                    if interface_errs:
                        for ie in interface_errs:
                            msg = f"  ADAPTER INTERFACE ERROR: {ie}"
                            report.append(msg)
                            errors.append(msg)
                    else:
                        report.append(f"  PASS — workitem-source: adapter={adapter}, "
                                     f"class={class_name}, all 4 abstract methods implemented")
        else:
            msg = "  workitem-source.yaml not a valid dict"
            report.append(msg)
            errors.append(msg)

    # 9c. merge-policy.yaml
    mp_file = harness_dir / "planning" / "merge-policy.yaml"
    if scope < 3:
        report.append("  SKIP — scope<3, merge-policy gated out")
    elif not mp_file.exists():
        msg = "  MISSING planning/merge-policy.yaml — merge strategy undefined"
        report.append(msg)
        errors.append(msg)
    else:
        mp = load_yaml(mp_file)
        if isinstance(mp, dict):
            policy = mp.get("policy")
            if criticality >= 4 and policy != "rebase_only":
                msg = (f"  VIOLATION — criticality={criticality} requires policy=rebase_only, "
                       f"got policy={policy!r}")
                report.append(msg)
                errors.append(msg)
            elif not policy:
                msg = "  merge-policy.policy empty"
                report.append(msg)
                errors.append(msg)
            else:
                report.append(f"  PASS — merge-policy: {policy} (criticality={criticality})")
        else:
            msg = "  merge-policy.yaml not a valid dict"
            report.append(msg)
            errors.append(msg)

    # 9d. agent-protocol.yaml role 与 prototypes 一致
    ap_file = harness_dir / "planning" / "agent-protocol.yaml"
    if scope < 3:
        report.append("  SKIP — scope<3, agent-protocol gated out")
    elif not ap_file.exists():
        msg = "  MISSING planning/agent-protocol.yaml — leaf protocol config undefined"
        report.append(msg)
        errors.append(msg)
    else:
        ap = load_yaml(ap_file)
        proto_file = harness_dir / "planning" / "sub-agent-dispatch.yaml"
        if isinstance(ap, dict) and proto_file.exists():
            proto_data = load_yaml(proto_file)
            if isinstance(proto_data, dict):
                proto_names = set((proto_data.get("prototypes") or {}).keys())
                ap_roles = set((ap.get("roles") or {}).keys())
                # agent-protocol 的 roles 应是 prototypes 的子集（不是所有 prototype 都是 leaf role）
                missing = ap_roles - proto_names
                if missing:
                    msg = (f"  agent-protocol.yaml defines roles not in sub-agent-dispatch prototypes: "
                           f"{sorted(missing)}")
                    report.append(msg)
                    warnings.append(msg)
                else:
                    report.append(f"  PASS — agent-protocol: {len(ap_roles)} roles, "
                                 f"all match prototypes")
    report.append("")

    # 9e. doc contracts 存在 + evolution 字段
    for doc_slot in ("docs/harness-doc-contract.yaml", "docs/project-doc-contract.yaml"):
        dc_file = harness_dir / doc_slot
        if not dc_file.exists():
            msg = f"  MISSING {doc_slot} — documentation contract required"
            report.append(msg)
            errors.append(msg)
        else:
            dc = load_yaml(dc_file)
            if isinstance(dc, dict):
                evo = dc.get("evolution") or {}
                if not evo:
                    msg = f"  {doc_slot} missing 'evolution' field — docs not in evolution loop"
                    report.append(msg)
                    errors.append(msg)
                else:
                    report.append(f"  PASS — {doc_slot}: evolution field present")
            else:
                msg = f"  {doc_slot} not a valid dict"
                report.append(msg)
                errors.append(msg)
    report.append("")

    # 总结
    report.append("=== Summary ===")
    report.append(f"  Errors:   {len(errors)}")
    report.append(f"  Warnings: {len(warnings)}")
    passed = len(errors) == 0
    report.append(f"  Result:   {'PASS' if passed else 'FAIL'}")
    return passed, report


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/validate-harness.py <harness_dir>")
        sys.exit(2)
    harness_dir = Path(sys.argv[1]).resolve()
    if not harness_dir.is_dir():
        print(f"ERROR: {harness_dir} is not a directory")
        sys.exit(2)
    passed, report = validate(harness_dir)
    print("\n".join(report))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
