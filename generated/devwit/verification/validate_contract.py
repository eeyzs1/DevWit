#!/usr/bin/env python3
"""
VALIDATE-CONTRACT: fail-closed validation of agent-written structured outputs
(WP2, the "semantic capability seam" consumer).

An LLM step writes a structured output (judgment-report, audit-report,
innovation-proposals, ...). This script checks:
  1. the output parses and satisfies its contract schema (subset validator);
  2. every evidence reference is TRACEABLE to the event log / artifacts /
     real files under the project (model-visible <-> logged; no hallucinated
     refs; fail-closed on anything unresolvable).

Evidence reference forms:
    event:<seq>            an event with that seq exists in the log
    verify:<name>          a verify/run evidence entry exists (and passed)
    test:<name>            a test/run evidence entry exists (and passed)
    audit:<round>          an audit/round evidence entry exists
    artifact:<key>         a spilled artifact with that key exists
    file:<relative-path>   the file exists under --project-root

Exit: 0 = valid, 1 = invalid (reasons on stderr).

Usage:
    python scripts/validate_contract.py --schema <schema.yaml> --output <out.yaml> \
        [--log <event-log.yaml>] [--project-root <dir>]
"""

import argparse
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------- schema subset

def _type_ok(value, typ: str) -> bool:
    if typ == "string":
        return isinstance(value, str)
    if typ == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if typ == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if typ == "boolean":
        return isinstance(value, bool)
    if typ == "array":
        return isinstance(value, list)
    if typ == "object":
        return isinstance(value, dict)
    return True


def validate_value(value, schema: dict, path: str, errors: list) -> None:
    if not isinstance(schema, dict):
        return
    typ = schema.get("type")
    if typ and not _type_ok(value, typ):
        errors.append(f"{path}: expected {typ}, got {type(value).__name__}")
        return
    if isinstance(value, dict):
        for req in schema.get("required", []) or []:
            if req not in value:
                errors.append(f"{path}: missing required field '{req}'")
        if schema.get("additionalProperties") is False:
            allowed = set((schema.get("properties") or {}).keys())
            unknown = [k for k in value if k not in allowed]
            if unknown:
                errors.append(f"{path}: unexpected fields {sorted(unknown)} "
                              f"(additionalProperties=false)")
        for key, sub in (schema.get("properties") or {}).items():
            if key in value:
                validate_value(value[key], sub, f"{path}.{key}", errors)
    if typ == "array" and isinstance(value, list):
        items = schema.get("items")
        for i, item in enumerate(value):
            validate_value(item, items, f"{path}[{i}]", errors)
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: expected >= {schema['minItems']} items, got {len(value)}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: expected <= {schema['maxItems']} items, got {len(value)}")
    if "enum" in schema and isinstance(value, (str, int, float, bool)):
        if value not in schema["enum"]:
            errors.append(f"{path}: {value!r} not in enum {schema['enum']}")
    if typ == "string" and isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")


def load_schema(path: Path) -> dict:
    if not path.exists():
        raise ValueError(f"schema not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise ValueError(f"{path}: unknown schema version (expected 1)")
    return doc


def load_output(path: Path):
    if not path.exists():
        raise ValueError(f"output not found: {path} -- the LLM step did not produce its contract output")
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------- traceability

# Only these event types count as EVIDENCE for `event:` references (P0#3).
# Citing an error/recorded, meta/set, or other non-evidence event is rejected.
EVIDENCE_EVENTS = {"verify/run", "test/run", "audit/round", "artifact/spilled"}


def collect_evidence(events: list) -> dict:
    """Fold the log into a lookup: {kind: {name: passed}} + artifacts + seq map."""
    lookup = {"verify": {}, "test": {}, "audit": {}, "events": {}, "artifacts": {}}
    for ev in events:
        lookup["events"][ev.get("seq")] = ev.get("type", "")
        typ = ev.get("type", "")
        payload = ev.get("payload", {}) or {}
        if typ == "artifact/spilled":
            lookup["artifacts"][payload.get("key")] = payload
        elif typ in ("verify/run", "test/run", "audit/round"):
            kind = typ.split("/")[0]
            name = payload.get("name") or payload.get("command") or str(ev.get("seq"))
            passed = bool(payload.get("passed", payload.get("exit") == 0))
            lookup[kind][name] = passed
    return lookup


def check_refs(refs: list, evidence: dict, project_root: Path, errors: list) -> None:
    for ref in refs or []:
        if not isinstance(ref, str) or not ref:
            errors.append(f"evidence_ref {ref!r}: must be a non-empty string")
            continue
        if ref.startswith("event:"):
            seq = ref[len("event:"):]
            if not seq.isdigit() or int(seq) not in evidence["events"]:
                errors.append(f"evidence_ref {ref!r}: no event with that seq in the log")
            elif evidence["events"][int(seq)] not in EVIDENCE_EVENTS:
                errors.append(
                    f"evidence_ref {ref!r}: event {seq} is "
                    f"{evidence['events'][int(seq)]}, not an evidence event "
                    f"(only verify/test/audit/artifact events are citable)")
        elif ref.startswith("artifact:"):
            key = ref[len("artifact:"):]
            if key not in evidence["artifacts"]:
                errors.append(f"evidence_ref {ref!r}: no spilled artifact with key {key!r}")
        elif ref.startswith(("verify:", "test:", "audit:")):
            kind, name = ref.split(":", 1)
            if kind not in ("verify", "test", "audit"):
                errors.append(f"evidence_ref {ref!r}: unknown kind {kind!r}")
                continue
            entries = evidence[kind]
            if name not in entries:
                errors.append(f"evidence_ref {ref!r}: no {kind}/run entry named {name!r}")
            elif kind != "audit" and not entries[name]:
                errors.append(f"evidence_ref {ref!r}: {kind} entry {name!r} did not pass")
        elif ref.startswith("file:"):
            rel = ref[len("file:"):]
            if project_root is None or not (project_root / rel).is_file():
                errors.append(f"evidence_ref {ref!r}: file not found under project root")
        else:
            errors.append(f"evidence_ref {ref!r}: unrecognized form "
                          f"(expected event:|verify:|test:|audit:|artifact:|file:)")


def enforce_verdict_refs(output, errors: list) -> None:
    """Cross-field rule: a per-criterion `verdict: PROVEN` MUST carry a
    non-empty `evidence_refs` in the same object. Schemas cannot express this;
    we can. Root/aggregate verdicts (no `criterion` key) are not checked."""
    def walk(node, path):
        if isinstance(node, dict):
            if node.get("verdict") == "PROVEN" and "criterion" in node:
                refs = node.get("evidence_refs") or []
                if not isinstance(refs, list) or not refs:
                    errors.append(f"{path}: verdict PROVEN requires at least one evidence_ref")
            for k, v in node.items():
                walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]")
    walk(output, "output")


# ---------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description="Validate a contract output + evidence traceability")
    ap.add_argument("--schema", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--log", default=None, help="event log to resolve evidence refs against")
    ap.add_argument("--project-root", default=None, help="project root for file: refs")
    ap.add_argument("--ref-field", default=None,
                    help="JSON-ish path to the refs field, e.g. 'criteria[].evidence_refs'")
    args = ap.parse_args()

    errors = []
    try:
        schema = load_schema(Path(args.schema))
        output = load_output(Path(args.output))
    except ValueError as e:
        print(f"CONTRACT FAIL: {e}", file=sys.stderr)
        return 1

    root = "output"
    validate_value(output, schema, root, errors)
    enforce_verdict_refs(output, errors)

    # Traceability: collect refs wherever they appear (depth-first walk).
    evidence = {}
    if args.log:
        try:
            with open(args.log, "r", encoding="utf-8") as f:
                doc = yaml.safe_load(f) or {}
            evidence = collect_evidence(doc.get("events", []) or [])
        except Exception as e:
            print(f"CONTRACT FAIL: cannot read log {args.log}: {e}", file=sys.stderr)
            return 1

    refs = []
    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "evidence_refs":
                    refs.extend(v if isinstance(v, list) else [v])
                else:
                    walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(output)

    project_root = Path(args.project_root).resolve() if args.project_root else None
    check_refs(refs, evidence, project_root, errors)

    if errors:
        print("CONTRACT FAIL:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"CONTRACT PASS ({len(refs)} evidence refs traceable)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
