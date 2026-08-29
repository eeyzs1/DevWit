#!/usr/bin/env python3
"""
Innovation Engine: Discover unmet needs and propose innovations.

After all acceptance criteria are met, this engine analyzes the product
state against domain advancement patterns to propose new features.

This is the "推陈出新" (innovation) component of the self-evolving harness.

Usage:
    python evolution/innovation-engine.py [--project-root <dir>] [--dry-run]
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DOMAIN_ADVANCEMENT_MAP = {
    "web-app": "domain-advancements.yaml",
    "api-service": "domain-advancements-api.yaml",
    "automation": "domain-advancements.yaml",
    "data-pipeline": "domain-advancements.yaml",
    "content-system": "domain-advancements.yaml",
}


def load_product_state(project_root: Path) -> dict:
    analyzer = project_root / "evolution" / "product-analyzer.py"
    if analyzer.exists():
        import subprocess
        proc = subprocess.run(
            [sys.executable, str(analyzer), "--project-root", str(project_root)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return yaml.safe_load(proc.stdout) or {}
    return {"all_criteria_met": False, "criteria_progress": {"completion_rate": 0}}


def load_domain_advancements(project_root: Path, template_name: str) -> dict:
    adv_file = project_root / "evolution" / DOMAIN_ADVANCEMENT_MAP.get(template_name, "domain-advancements.yaml")
    if not adv_file.exists():
        return {"stages": []}
    with open(adv_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {"stages": []}


def detect_template(project_root: Path) -> str:
    task_file = project_root / "task.yaml"
    if task_file.exists():
        with open(task_file, "r", encoding="utf-8") as f:
            task = yaml.safe_load(f) or {}
        domain = task.get("domain", "").lower()
        domain_map = {
            "web_app": "web-app", "api_service": "api-service",
            "automation": "automation", "data_pipeline": "data-pipeline",
            "content_system": "content-system",
        }
        return domain_map.get(domain, "web-app")
    return "web-app"


def determine_current_stage(product_state: dict, advancements: dict) -> str:
    completion_rate = product_state.get("criteria_progress", {}).get("completion_rate", 0)
    all_met = product_state.get("all_criteria_met", False)

    if not all_met:
        return "Basic"

    structure = product_state.get("structure", {})
    files_with_content = structure.get("files_with_content", 0)
    has_tests = product_state.get("tests", {}).get("has_tests", False)
    total_tests = product_state.get("tests", {}).get("total_tests", 0)

    # FIXED (was: else -> "Solid" even for an empty product): stage must be
    # derived from FACTS, and the default for weak evidence is Basic.
    if files_with_content > 10 and total_tests > 10:
        return "Advanced"
    if files_with_content > 5 and has_tests and total_tests > 5:
        return "Solid"
    return "Basic"


def propose_innovations(product_state: dict, advancements: dict, current_stage: str) -> list:
    proposals = []
    stage_names = [s.get("name", "") for s in advancements.get("stages", [])]
    current_idx = stage_names.index(current_stage) if current_stage in stage_names else 0

    next_stage_idx = current_idx + 1
    if next_stage_idx >= len(advancements.get("stages", [])):
        return proposals

    next_stage = advancements["stages"][next_stage_idx]
    next_stage_name = next_stage.get("name", "Unknown")

    innovations = next_stage.get("innovations", [])
    for innovation in innovations:
        trigger = innovation.get("trigger", "")
        category = innovation.get("category", "general")
        effort = innovation.get("effort", "medium")
        impact = innovation.get("impact", "medium")

        proposals.append({
            "id": innovation.get("id", "UNKNOWN"),
            "name": innovation.get("name", "Unknown"),
            "description": innovation.get("description", ""),
            "category": category,
            "effort": effort,
            "impact": impact,
            "trigger_condition": trigger,
            "target_stage": next_stage_name,
            "type": "product_innovation",
            "requires_approval": effort == "high" or category == "security",
            "proposed_at": datetime.now().isoformat(),
        })

    return proposals


def prioritize_innovations(proposals: list) -> list:
    impact_weight = {"high": 3, "medium": 2, "low": 1}
    effort_weight = {"low": 3, "medium": 2, "high": 1}

    def score(p):
        return impact_weight.get(p.get("impact", "medium"), 2) * 2 + effort_weight.get(p.get("effort", "medium"), 2)

    return sorted(proposals, key=score, reverse=True)


# ============================================================================
# Doc staleness detection (v2.6+)
# 读 docs/{harness,project}-doc-contract.yaml 的 evolution.staleness_check，
# 检查文档文件是否过时（mtime > max_age_days）。过时则生成 doc_refresh 提案。
# ============================================================================

DOC_CONTRACT_FILES = [
    "docs/harness-doc-contract.yaml",
    "docs/project-doc-contract.yaml",
]


def detect_doc_staleness(project_root: Path) -> list:
    """扫所有 doc contracts，检测文档过时。

    Returns:
      stale docs list: [{"contract_file", "doc_name", "path", "age_days",
                          "max_age_days", "proposal_type"}...]
    """
    now = datetime.now()
    stale_docs = []

    for contract_rel in DOC_CONTRACT_FILES:
        contract_file = project_root / contract_rel
        if not contract_file.exists():
            continue
        try:
            with open(contract_file, "r", encoding="utf-8") as f:
                contract = yaml.safe_load(f) or {}
        except Exception:
            continue

        evo_cfg = contract.get("evolution") or {}
        staleness = evo_cfg.get("staleness_check") or {}
        if not staleness.get("enabled", False):
            continue

        max_age_days = staleness.get("max_age_days", 30)
        proposal_type = staleness.get("proposal_type", "doc_refresh")
        trigger = staleness.get("trigger", "innovation_engine")

        for doc in contract.get("documents") or []:
            doc_name = doc.get("name")
            if not doc_name:
                continue
            doc_path = project_root / doc_name
            if not doc_path.exists():
                # 文档不存在——本身就是 stale（应该 generate_when 触发但没生成）
                stale_docs.append({
                    "contract_file": contract_rel,
                    "doc_name": doc_name,
                    "path": str(doc_path),
                    "age_days": None,
                    "max_age_days": max_age_days,
                    "proposal_type": proposal_type,
                    "reason": "doc file missing",
                })
                continue

            # 检查 mtime
            try:
                mtime = datetime.fromtimestamp(doc_path.stat().st_mtime)
                age_days = (now - mtime).days
                if age_days > max_age_days:
                    stale_docs.append({
                        "contract_file": contract_rel,
                        "doc_name": doc_name,
                        "path": str(doc_path),
                        "age_days": age_days,
                        "max_age_days": max_age_days,
                        "proposal_type": proposal_type,
                        "reason": f"doc last modified {age_days} days ago (max {max_age_days})",
                    })
            except Exception as e:
                stale_docs.append({
                    "contract_file": contract_rel,
                    "doc_name": doc_name,
                    "path": str(doc_path),
                    "age_days": None,
                    "max_age_days": max_age_days,
                    "proposal_type": proposal_type,
                    "reason": f"cannot stat: {e}",
                })

    return stale_docs


def propose_doc_refresh(stale_docs: list) -> list:
    """把 stale docs 转成 doc_refresh 提案（带 file: 证据引用或 assumption 标记）。"""
    proposals = []
    for i, sd in enumerate(stale_docs, 1):
        age_str = f"{sd['age_days']} days" if sd["age_days"] is not None else "unknown"
        doc_exists = sd.get("reason") != "doc file missing"
        proposals.append({
            "id": f"DOC-REFRESH-{i:03d}",
            "name": f"Refresh stale doc: {sd['doc_name']}",
            "description": (
                f"Document {sd['doc_name']} is stale ({sd['reason']}). "
                f"Regenerate per {sd['contract_file']}."
            ),
            "category": "documentation",
            "effort": "low",
            "impact": "medium",
            "trigger_condition": f"doc staleness check: age={age_str}, max={sd['max_age_days']}d",
            "target_stage": "current",
            "type": "doc_refresh",
            "requires_approval": False,
            "proposed_at": datetime.now().isoformat(),
            "doc_path": sd["path"],
            "doc_name": sd["doc_name"],
            "proposal_type": sd["proposal_type"],
            "evidence_refs": [f"file:{sd['doc_name']}"] if doc_exists else [],
            "assumption": not doc_exists,
        })
    return proposals



# ============================================================================
# Contract-driven innovation (WP4): proposals come from the INNOVATE prompt
# contract (evolution/innovation-proposals.yaml), NOT from dumping a canned YAML
# list. The engine validates schema + evidence traceability, fail-closed.
# ============================================================================

PROPOSALS_FILE = "evolution/innovation-proposals.yaml"
ALLOWED_EFFORT = {"low", "medium", "high"}
ALLOWED_IMPACT = {"low", "medium", "high"}
REQUIRED_FIELDS = ("id", "name", "description", "effort", "impact")


def _load_events(project_root: Path) -> list:
    log_file = project_root / "memory" / "event-log.yaml"
    if not log_file.exists():
        return []
    with open(log_file, "r", encoding="utf-8") as f:
        return (yaml.safe_load(f) or {}).get("events", []) or []


def _resolve_ref(ref: str, project_root: Path, events: list) -> tuple:
    """Return (ok, reason). file: must exist; event: must be in the log."""
    if ref.startswith("file:"):
        p = project_root / ref[len("file:"):]
        return (p.exists(), f"file not found: {ref}")
    if ref.startswith("event:"):
        seq = ref[len("event:"):]
        if seq.isdigit() and any(ev.get("seq") == int(seq) for ev in events):
            return True, None
        return False, f"no event with seq {seq} in memory/event-log.yaml"
    if ref.startswith("artifact:"):
        key = ref[len("artifact:"):]
        if any(ev.get("type") == "artifact/spilled" and
               (ev.get("payload") or {}).get("key") == key for ev in events):
            return True, None
        return False, f"no spilled artifact key {key!r}"
    return False, f"unrecognized evidence_ref form: {ref!r}"


def _validate_proposals(proposals: list, project_root: Path) -> list:
    """Fail-closed validation. Returns a list of error strings ([] == OK)."""
    errors = []
    events = _load_events(project_root)
    for i, p in enumerate(proposals):
        path = f"proposals[{i}]"
        if not isinstance(p, dict):
            errors.append(f"{path}: not an object")
            continue
        for field in REQUIRED_FIELDS:
            if not p.get(field):
                errors.append(f"{path}: missing required field '{field}'")
        if p.get("effort") not in ALLOWED_EFFORT:
            errors.append(f"{path}: effort {p.get('effort')!r} not in {sorted(ALLOWED_EFFORT)}")
        if p.get("impact") not in ALLOWED_IMPACT:
            errors.append(f"{path}: impact {p.get('impact')!r} not in {sorted(ALLOWED_IMPACT)}")
        refs = p.get("evidence_refs") or []
        if not refs and not p.get("assumption"):
            errors.append(f"{path}: proposal needs >=1 evidence_ref OR assumption: true")
        for ref in refs:
            ok, reason = _resolve_ref(ref, project_root, events)
            if not ok:
                errors.append(f"{path}: {reason}")
    return errors


def _load_contract_proposals(project_root: Path) -> tuple:
    """Read evolution/innovation-proposals.yaml; return (proposals, error) or (None, reason)."""
    f = project_root / PROPOSALS_FILE
    if not f.exists():
        return None, "absent"
    try:
        with open(f, "r", encoding="utf-8") as fh:
            doc = yaml.safe_load(fh) or {}
    except Exception as e:
        return None, f"unparsable: {e}"
    proposals = doc.get("proposals") or []
    if not isinstance(proposals, list):
        return None, "'proposals' is not a list"
    errors = _validate_proposals(proposals, project_root)
    if errors:
        return None, "; ".join(errors)
    return proposals, None


def run_innovation_cycle(project_root: Path, dry_run: bool = False) -> dict:
    print(f"\n{'='*60}")
    print("INNOVATION ENGINE — 推陈出新")
    print(f"{'='*60}")

    product_state = load_product_state(project_root)
    all_met = product_state.get("all_criteria_met", False)
    completion_rate = product_state.get("criteria_progress", {}).get("completion_rate", 0)

    print(f"\nProduct state: {completion_rate*100:.0f}% criteria met")
    print(f"All criteria met: {all_met}")

    if not all_met:
        print("\n⚠️  Not all acceptance criteria are met yet.")
        print("   Complete the current requirements first, then innovation can begin.")
        return {"status": "requirements_not_met", "proposals": []}

    template_name = detect_template(project_root)
    advancements = load_domain_advancements(project_root, template_name)
    current_stage = determine_current_stage(product_state, advancements)

    print(f"Current stage: {current_stage}")
    print(f"Domain template: {template_name}")

    # WP4: proposals come ONLY from the INNOVATE prompt contract.
    proposals, perr = _load_contract_proposals(project_root)
    if proposals is None:
        print("\nℹ️  No innovation-proposals.yaml (or it is invalid).")
        if perr != "absent":
            print(f"   INVALID: {perr}")
        print("   Run the INNOVATE prompt contract "
              "(meta/prompt-contracts/innovate/instructions.md) to produce "
              f"{PROPOSALS_FILE}. domain-advancements*.yaml is an EXAMPLE BANK, "
              "not the source of truth.")
        return {"status": "no_proposals_contract", "proposals": []}
    print(f"\nContract proposals: {len(proposals)} (validated, evidence traceable)")

    # Approval tiering (WP4): high-effort or security proposals need approval.
    for p in proposals:
        p["requires_approval"] = (p.get("effort") == "high" or
                                  p.get("category") == "security")

    # Doc staleness check (v2.6+)：与 product innovation 并行
    # 注意：doc_refresh 不受 all_met 限制——即使 AC 未全完成，文档也可能过时
    stale_docs = detect_doc_staleness(project_root)
    if stale_docs:
        doc_proposals = propose_doc_refresh(stale_docs)
        proposals.extend(doc_proposals)
        print(f"\n📄 Doc staleness: {len(stale_docs)} stale doc(s) detected")
        for sd in stale_docs:
            age_str = f"{sd['age_days']}d" if sd["age_days"] is not None else "?"
            print(f"   - {sd['doc_name']} (age={age_str}, max={sd['max_age_days']}d) — {sd['reason']}")

    proposals = prioritize_innovations(proposals)

    if not proposals:
        print("\n✅ Product is at the highest advancement stage. No further innovations proposed.")
        return {"status": "max_stage_reached", "proposals": []}

    next_stage = proposals[0].get("target_stage", "Unknown") if proposals else "Unknown"
    print(f"\nNext stage: {next_stage}")
    print(f"Innovation proposals: {len(proposals)}")

    for i, p in enumerate(proposals, 1):
        approval_tag = "🔒 NEEDS APPROVAL" if p.get("requires_approval") else "🟢 AUTO-APPROVED"
        print(f"\n  {i}. [{p['id']}] {p['name']} {approval_tag}")
        print(f"     Category: {p['category']} | Effort: {p['effort']} | Impact: {p['impact']}")
        print(f"     Description: {p['description']}")
        print(f"     Trigger: {p['trigger_condition']}")

    if not dry_run:
        innovation_log = project_root / "evolution" / "innovation-log.yaml"
        existing = []
        if innovation_log.exists():
            with open(innovation_log, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
                existing = data.get("proposals", [])

        for p in proposals:
            p["status"] = "proposed"
            existing.append(p)

        with open(innovation_log, "w", encoding="utf-8") as f:
            yaml.dump({"version": 1, "proposals": existing}, f, default_flow_style=False, allow_unicode=True)

        print(f"\n📝 Proposals saved to evolution/innovation-log.yaml")

        genome_file = project_root / "evolution" / "genome.yaml"
        if genome_file.exists():
            with open(genome_file, "r", encoding="utf-8") as f:
                genome = yaml.safe_load(f) or {}
            genome.setdefault("harness_genome", {}).setdefault("skills", [])
            for p in proposals:
                if not any(s.get("name") == p["name"] for s in genome["harness_genome"]["skills"]):
                    genome["harness_genome"]["skills"].append({
                        "id": p["id"],
                        "name": p["name"],
                        "source": f"innovation engine: {p['trigger_condition']}",
                        "status": "proposed",
                    })
            with open(genome_file, "w", encoding="utf-8") as f:
                yaml.dump(genome, f, default_flow_style=False, allow_unicode=True)

    return {"status": "innovations_proposed", "proposals": proposals, "current_stage": current_stage, "next_stage": next_stage}


def main():
    parser = argparse.ArgumentParser(description="Innovation Engine — 推陈出新")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--dry-run", action="store_true", help="Propose without saving")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    run_innovation_cycle(project_root, args.dry_run)


if __name__ == "__main__":
    main()
