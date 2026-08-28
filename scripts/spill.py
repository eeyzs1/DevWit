#!/usr/bin/env python3
"""
SPILL: persist oversized text to disk, keep only a locator in state (WP7,
borrowed from DSH spill).

BEST-EFFORT by contract: a real storage failure (permissions, ENOSPC) is
REPORTED but never turns success into failure -- the caller keeps the inline
result. The locator is written through an artifact/spilled event so the log
remains the source of truth.

Usage:
    python scripts/spill.py --log <event-log.yaml> --key <key> [--text <text> | --file <path>] \
        [--root <meta-dir>] [--max-bytes N]
Exit 0 always (best-effort); prints SPILLED <locator> or INLINE.
"""

import argparse
import hashlib
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import state_fold  # noqa: E402


def save_text(log_path, key: str, text: str, root: Path, max_bytes: int) -> dict:
    """Return {status: spilled|inline, locator?, bytes?}. Never raises on I/O."""
    if len(text) <= max_bytes:
        return {"status": "inline", "bytes": len(text)}
    try:
        artifacts = root / "meta" / "artifacts"
        artifacts.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        target = artifacts / f"{key}-{digest}.txt"
        fd, tmp = tempfile.mkstemp(dir=str(artifacts), prefix=".spill-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception as e:
        print(f"WARN: spill failed ({e}) -- keeping inline (best-effort)", file=sys.stderr)
        return {"status": "inline", "bytes": len(text)}

    locator = str(target)
    events = [{"type": "artifact/spilled", "phase": None,
               "payload": {"key": key, "locator": locator,
                           "bytes": len(text),
                           "retrievalHint": f"read {locator} to load the full text"}}]
    try:
        state_fold.append_events(Path(log_path), events)
        # Keep derived projections in sync with the log (log is truth).
        _refresh_projections(root, log_path)
    except Exception as e:
        print(f"WARN: artifact event not recorded ({e}) -- locator still valid",
              file=sys.stderr)
    return {"status": "spilled", "locator": locator, "bytes": len(text)}


def _refresh_projections(root: Path, log_path) -> None:
    """Re-fold and rewrite pipeline-state.yaml + PHASE_BRIEF.md if they exist."""
    state_path = root / "meta" / "pipeline-state.yaml"
    brief_path = root / ".meta-harness" / "PHASE_BRIEF.md"
    if not state_path.exists() and not brief_path.exists():
        return
    state = state_fold.fold(state_fold.load_events(log_path))
    if state_path.exists():
        state_fold.write_projection(state, state_path)
    if brief_path.exists():
        try:
            import brief_gen
            brief_path.parent.mkdir(parents=True, exist_ok=True)
            brief_path.write_text(brief_gen.render_brief(state), encoding="utf-8")
        except Exception:
            pass  # brief refresh is best-effort; state is authoritative


def main():
    ap = argparse.ArgumentParser(description="Spill oversized text to disk with a locator")
    ap.add_argument("--log", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--text", default=None)
    ap.add_argument("--file", default=None)
    ap.add_argument("--root", default=".", help="project/meta root (default: cwd)")
    ap.add_argument("--max-bytes", type=int, default=8192)
    args = ap.parse_args()

    if args.text is not None:
        text = args.text
    elif args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    else:
        print("provide --text or --file", file=sys.stderr)
        sys.exit(2)

    result = save_text(args.log, args.key, text, Path(args.root).resolve(), args.max_bytes)
    if result["status"] == "spilled":
        print(f"SPILLED {result['locator']} ({result['bytes']} bytes)")
    else:
        print(f"INLINE ({result['bytes']} bytes)")
    sys.exit(0)


if __name__ == "__main__":
    main()
