#!/usr/bin/env python3
"""
COMPACT-CONTEXT: regenerate PHASE_BRIEF.md as a compaction with lock markers
(WP7, borrowed from DSH compaction).

The resume brief is a SUMMARY derived from the event log. The compaction is
lock-bracketed in the log itself: compaction/start is appended first, then the
brief is regenerated, then compaction/summary and compaction/end. A crash in
between leaves an ORPHANED start that compact-context (and log_invariant) can
detect -- never a silently stale brief.

The summary references the log by its asOfSeq watermark, so prior evidence is
preserved via seq/pointer references instead of being copied inline.

Usage:
    python scripts/compact_context.py --log <event-log.yaml> --state <pipeline-state.yaml> \
        --brief <PHASE_BRIEF.md>
Exit 0 = compaction committed; 1 = orphaned compaction detected (or log invalid).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import brief_gen  # noqa: E402
import state_fold  # noqa: E402


def has_orphan_compaction(events: list) -> bool:
    starts = sum(1 for e in events if e["type"] == "compaction/start")
    ends = sum(1 for e in events if e["type"] == "compaction/end")
    return starts > ends


def main():
    ap = argparse.ArgumentParser(description="Regenerate the brief as a lock-bracketed compaction")
    ap.add_argument("--log", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--brief", required=True)
    args = ap.parse_args()

    log_path, state_path, brief_path = Path(args.log), Path(args.state), Path(args.brief)
    # Bootstrap a well-formed log first (phase/start) when none exists.
    state_fold.ensure_log(log_path, state_path)
    events = state_fold.load_events(log_path)

    if has_orphan_compaction(events):
        print("COMPACT FAIL: orphaned compaction/start without compaction/end "
              "-- previous summarization crashed mid-way; refusing to guess",
              file=sys.stderr)
        sys.exit(1)

    rev = len(events)
    state_fold.append_events(
        log_path,
        [{"type": "compaction/start", "phase": None, "payload": {"watermark": rev}}],
        expected_revision=rev)
    # The summary IS the derived brief, at the new watermark.
    events = state_fold.load_events(log_path)
    state = state_fold.fold(events)
    state_fold.write_projection(state, state_path)
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.write_text(brief_gen.render_brief(state), encoding="utf-8")

    rev = len(events)
    state_fold.append_events(
        log_path,
        [{"type": "compaction/summary", "phase": None,
          "payload": {"asOfSeq": rev + 1, "brief": str(brief_path)}},
         {"type": "compaction/end", "phase": None,
          "payload": {"asOfSeq": rev + 2}}],
        expected_revision=rev)

    # Leave projections at the FINAL watermark (the compaction markers are
    # part of the log the brief must stay in sync with).
    final = state_fold.fold(state_fold.load_events(log_path))
    state_fold.write_projection(final, state_path)
    brief_path.write_text(brief_gen.render_brief(final), encoding="utf-8")
    print(f"compaction committed -> {brief_path} (asOfSeq {final['revision']})")
    sys.exit(0)


if __name__ == "__main__":
    main()
