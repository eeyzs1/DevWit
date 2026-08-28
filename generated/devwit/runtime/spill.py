#!/usr/bin/env python3
"""
SPILL (Fusion Plan v3 — A-WU7): persist oversized text to disk, keep only a
locator in state. Borrowed from DSH spill.

BEST-EFFORT by contract: a real storage failure (permissions, ENOSPC) is
REPORTED but never turns success into failure -- the caller keeps the inline
result. The locator is written through an artifact/spilled event so the log
remains the source of truth.

Usage:
    python runtime/spill.py --project-root <root> --key <key> \
        [--text <text> | --file <path>] [--max-bytes N]
Exit 0 always (best-effort); prints SPILLED <locator> or INLINE.
"""

import argparse
import hashlib
import os
import sys
import tempfile
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import event_log  # noqa: E402


def save_text(project_root: Path, key: str, text: str, max_bytes: int) -> dict:
    """Return {status: spilled|inline, locator?, bytes?}. Never raises on I/O."""
    if len(text) <= max_bytes:
        return {"status": "inline", "bytes": len(text)}
    try:
        artifacts = project_root / "memory" / "artifacts"
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
    try:
        event_log.append_events([{
            "type": "artifact/spilled",
            "payload": {"key": key, "locator": locator, "bytes": len(text)},
        }], project_root=project_root)
        # keep the derived projection in sync (log is truth)
        state = event_log.load_session_state(project_root)
        event_log.save_session_state(state, project_root)
    except Exception as e:
        print(f"WARN: artifact event not recorded ({e}) -- locator still valid",
              file=sys.stderr)
    return {"status": "spilled", "locator": locator, "bytes": len(text)}


def main() -> int:
    ap = argparse.ArgumentParser(description="Spill oversized text to disk with a locator")
    ap.add_argument("--project-root", default=".", help="Project root directory")
    ap.add_argument("--key", required=True)
    ap.add_argument("--text", default=None)
    ap.add_argument("--file", default=None)
    ap.add_argument("--max-bytes", type=int, default=8192)
    args = ap.parse_args()

    if args.text is not None:
        text = args.text
    elif args.file:
        text = Path(args.file).read_text(encoding="utf-8")
    else:
        print("provide --text or --file", file=sys.stderr)
        return 2

    result = save_text(Path(args.project_root).resolve(), args.key, text, args.max_bytes)
    if result["status"] == "spilled":
        print(f"SPILLED {result['locator']} ({result['bytes']} bytes)")
    else:
        print(f"INLINE ({result['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
