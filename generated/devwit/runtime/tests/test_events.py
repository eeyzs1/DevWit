#!/usr/bin/env python3
"""Regression tests for runtime/events.py dispatch modes (Fusion Plan v3 — A-WU2).

Run:  python -m pytest runtime/tests/test_events.py -q
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from events import bail, emit, parallel, serial, waterfall  # noqa: E402


def test_emit_contains_listener_exception():
    calls = []

    def boom(*_a, **_k):
        raise RuntimeError("observer failure")

    def ok(*_a, **_k):
        calls.append("ok")

    emit([boom, ok])  # must not raise
    assert calls == ["ok"]


def test_serial_stops_at_first_truthy():
    calls = []
    listeners = [
        lambda *a, **k: calls.append(1) or None,
        lambda *a, **k: calls.append(2) or "STOP",
        lambda *a, **k: calls.append(3) or None,
    ]
    assert serial(listeners) == "STOP"
    assert calls == [1, 2]


def test_bail_is_serial_semantics():
    assert bail([lambda *a, **k: None, lambda *a, **k: "X"]) == "X"
    assert bail([lambda *a, **k: None, lambda *a, **k: None]) is None


def test_parallel_runs_all_and_contains():
    calls = []

    def boom(*_a, **_k):
        raise ValueError("x")

    def ok(*_a, **_k):
        calls.append("ok")
        return "r"

    results = parallel([boom, ok])
    assert results == [None, "r"]
    assert calls == ["ok"]


def test_waterfall_delegate_and_replace():
    def double(v, nxt, *_a, **_k):
        return nxt(v * 2)

    def add_one(v, nxt, *_a, **_k):
        return nxt(v + 1)

    assert waterfall([double, add_one], 10) == 21


def test_waterfall_short_circuit_without_next():
    def veto(_v, _nxt, *_a, **_k):
        return None  # 不调 next()：短路，当前值胜出

    def never(_v, _nxt, *_a, **_k):
        raise AssertionError("must not run")

    assert waterfall([veto, never], "keep") == "keep"


def test_waterfall_replace_by_return():
    def replace(_v, _nxt, *_a, **_k):
        return "replaced"

    def never(_v, _nxt, *_a, **_k):
        raise AssertionError("must not run")

    assert waterfall([replace, never], "orig") == "replaced"
