#!/usr/bin/env python3
"""
Mistake-to-Constraint: Reads meta-mistakes, extracts root causes, proposes new constraints.

This script closes the feedback loop: every mistake should produce
a new or strengthened constraint (ADR-002). Since WP6 it also:
  - writes a numbered postmortem record (memory/postmortems/NNNN-<slug>.md)
    with the "why did the gate miss it" structure;
  - appends a mistake/recorded event to the project's append-only event log
    (memory/event-log.yaml) when present, so the log stays the source of truth.

Usage:
    python feedback/mistake-to-constraint.py [--mistakes-file <path>]
        [--output <constraints-file>] [--project-root <dir>]
"""

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

import yaml


def parse_mistakes(mistakes_file: Path) -> list:
    if not mistakes_file.exists():
        return []

    content = mistakes_file.read_text(encoding="utf-8")
    mistakes = []
    current = {}

    for line in content.split("\n"):
        if line.startswith("## Meta-Mistake"):
            if current:
                mistakes.append(current)
            current = {"raw": line}
        elif line.startswith("Status:"):
            current["status"] = line.split(":", 1)[1].strip()
        elif line.startswith("Root Cause:"):
            current["root_cause"] = line.split(":", 1)[1].strip()
        elif line.startswith("Lesson:"):
            current["lesson"] = line.split(":", 1)[1].strip()

    if current:
        mistakes.append(current)

    return [m for m in mistakes if m.get("status") != "Resolved" and m.get("root_cause")]


def propose_constraints(mistakes: list, existing_constraints: list) -> list:
    existing_rules = {c.get("rule", "").lower() for c in existing_constraints}
    proposals = []
    constraint_id = len(existing_constraints) + 1

    for mistake in mistakes:
        root_cause = mistake.get("root_cause", "")
        lesson = mistake.get("lesson", root_cause)

        if not root_cause:
            continue

        rule_text = lesson if lesson else f"Prevent: {root_cause}"

        if rule_text.lower() not in existing_rules:
            proposals.append({
                "id": f"C{constraint_id:03d}",
                "rule": rule_text,
                "source": f"meta-mistake: {root_cause}",
                "last_triggered": None,
                "trigger_count": 0,
                "proposed_at": datetime.now().isoformat(),
                "evidence": mistake.get("root_cause", ""),
            })
            constraint_id += 1

    return proposals


# ---------------------------------------------------------------- postmortems (WP6)

def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:48] or "mistake"


def write_postmortems(project_root: Path, mistakes: list, proposals: list,
                      template: Path) -> list:
    """Write numbered postmortem records; returns the written file paths.

    Idempotent per (root cause, lesson): a record already present for the same
    root cause is not duplicated. The template is filled with the DSH-inspired
    structure: what broke / root cause / why it escaped / durable lesson.
    """
    postmortems_dir = project_root / "memory" / "postmortems"
    postmortems_dir.mkdir(parents=True, exist_ok=True)
    tpl = template.read_text(encoding="utf-8") if template.exists() else ""
    proposal_by_source = {}
    for p in proposals:
        proposal_by_source.setdefault(p.get("source", ""), p)

    written = []
    for mistake in mistakes:
        root_cause = mistake.get("root_cause", "").strip()
        if not root_cause:
            continue
        slug = _slugify(root_cause)
        # Idempotent: skip when any record already carries this slug.
        existing_names = [f.name for f in postmortems_dir.glob("*.md")]
        if any(n.endswith(f"-{slug}.md") for n in existing_names):
            continue
        number = len(existing_names) + 1
        target = postmortems_dir / f"{number:04d}-{slug}.md"
        source_key = f"meta-mistake: {root_cause}"
        proposal = proposal_by_source.get(source_key)
        guardrail = f"constraint {proposal['id']} proposed: {proposal['rule']}" if proposal \
            else "no new constraint proposed"
        body = (tpl or "# Postmortem {number}: {slug}\n\n"
                "## Executive Summary\n\n- **What broke**: {what}\n"
                "- **Root cause**: {root}\n"
                "- **Why it escaped the gates**: <fill in -- which gate should have caught this?>\n"
                "- **Durable lesson**: {lesson}\n\n"
                "## Guardrails\n\n- [ ] {guardrail}\n").format(
            number=f"{number:04d}", slug=slug, what=mistake.get("raw", root_cause),
            root=root_cause, lesson=mistake.get("lesson", ""), guardrail=guardrail)
        target.write_text(body, encoding="utf-8")
        written.append(target)
    return written


def record_mistake_events(project_root: Path, mistakes: list) -> None:
    """Append mistake/recorded events to memory/event-log.yaml (best-effort)."""
    log_file = project_root / "memory" / "event-log.yaml"
    if not log_file.exists():
        return
    try:
        with open(log_file, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
        events = doc.get("events", [])
        base = len(events)
        now = datetime.now().isoformat()
        for i, mistake in enumerate(mistakes, start=base + 1):
            events.append({
                "seq": i, "ts": now, "type": "mistake/recorded",
                "payload": {"message": mistake.get("root_cause", ""),
                            "code": "meta-mistake"},
            })
        with open(log_file, "w", encoding="utf-8") as f:
            yaml.dump({"version": 1, "events": _chain_events(events)}, f,
                      default_flow_style=False, allow_unicode=True, sort_keys=False)
    except Exception as e:
        print(f"WARN: could not record mistake/recorded events: {e}", file=sys.stderr)


def _chain_events(events: list) -> list:
    """P2#12 hash-chain integrity (kept in sync with orchestrator.py)."""
    import hashlib
    import json
    prev = ""
    chained = []
    for ev in events:
        ev = dict(ev)
        ev.pop("hash", None)
        canonical = json.dumps({k: v for k, v in ev.items() if k != "hash"},
                               sort_keys=True, ensure_ascii=False, default=str)
        ev["prev_hash"] = prev
        ev["hash"] = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        prev = ev["hash"]
        chained.append(ev)
    return chained


def main():
    parser = argparse.ArgumentParser(description="Mistake-to-Constraint Converter")
    parser.add_argument("--mistakes-file", default="memory/meta-mistakes.md", help="Path to meta-mistakes file")
    parser.add_argument("--constraints-file", default="constraints/architecture-rules.yaml", help="Path to existing constraints")
    parser.add_argument("--output", default=None, help="Output file for proposed constraints")
    parser.add_argument("--project-root", default=".", help="Project root (for postmortems + event log)")
    parser.add_argument("--template", default="seeds/feedback/postmortem-template.md",
                        help="Postmortem template path (relative to project root)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    mistakes = parse_mistakes(project_root / args.mistakes_file)
    print(f"Found {len(mistakes)} unresolved mistakes with root causes")

    existing = []
    constraints_path = project_root / args.constraints_file
    if constraints_path.exists():
        with open(constraints_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
            existing = data.get("rules", [])

    proposals = propose_constraints(mistakes, existing)

    if not proposals:
        print("No new constraints to propose.")
    else:
        print(f"\nProposed {len(proposals)} new constraint(s):")
        for p in proposals:
            print(f"  [{p['id']}] {p['rule']}")
            print(f"       Evidence: {p['evidence']}")

        output = yaml.dump({"proposed_constraints": proposals}, default_flow_style=False, allow_unicode=True)
        if args.output:
            Path(args.output).write_text(output, encoding="utf-8")
            print(f"\nProposals written to: {args.output}")
        else:
            print(f"\n{output}")

    # WP6: postmortems + event log linkage (best-effort, never blocks).
    template = project_root / args.template if (project_root / args.template).exists() \
        else Path(__file__).resolve().parent.parent / "seeds" / "feedback" / "postmortem-template.md"
    written = write_postmortems(project_root, mistakes, proposals, template)
    if written:
        print(f"\nPostmortems written: {len(written)}")
        for w in written:
            print(f"  {w.relative_to(project_root)}")
    record_mistake_events(project_root, mistakes)


if __name__ == "__main__":
    main()
