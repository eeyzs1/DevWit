"""Unit tests for the dispatch-mode helpers (WP2)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import events  # noqa: E402


def test_emit_contains_observer_failures():
    order = []

    def ok():
        order.append("ok")

    def boom():
        raise RuntimeError("observer must not break the loop")

    events.emit([boom, ok])
    assert order == ["ok"]


def test_bail_stops_at_first_truthy():
    seen = []

    def first():
        seen.append(1)
        return None

    def second():
        seen.append(2)
        return "refused"

    def third():
        seen.append(3)  # must never run
        return "later"

    result = events.bail([first, second, third])
    assert result == "refused"
    assert seen == [1, 2]


def test_serial_same_as_bail():
    result = events.serial([lambda: None, lambda: "x", lambda: "y"])
    assert result == "x"


def test_parallel_contains_failures():
    results = events.parallel([lambda: 1, lambda: 1 / 0, lambda: 3])
    assert results[0] == 1
    assert results[1] is None
    assert results[2] == 3


def test_waterfall_delegation():
    def wrap(value, next_fn):
        return next_fn(value * 2)

    result = events.waterfall([wrap, wrap], 1)
    assert result == 4


def test_waterfall_short_circuit_without_next():
    def veto(value, next_fn):
        return value  # returns without calling next() -> short-circuit

    result = events.waterfall([veto, lambda v, n: n(v + 1)], 5)
    assert result == 5


def test_waterfall_replace_value():
    def replace(value, next_fn):
        return next_fn(100)

    result = events.waterfall([replace, lambda v, n: n(v + 1)], 1)
    assert result == 101
