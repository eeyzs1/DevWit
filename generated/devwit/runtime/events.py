#!/usr/bin/env python3
"""
EVENTS: minimal dispatch modes borrowed from DSH/Cordis (WP2).

Listeners are plain callables. The dispatch mode is the public contract:
    emit      - fire-and-forget; a throwing listener is contained so one bad
                observer never breaks the loop.
    serial    - run in order; stop at the first truthy return value, which is
                the dispatch result (None if none bailed).
    bail      - same as serial but synchronous by contract (kept as a distinct
                name so call sites document intent).
    waterfall - around-middleware: each listener receives (value, next, *args).
                Call next(new_value) to delegate a (possibly wrapped) value to
                the next listener; return without calling next() to
                short-circuit, leaving the current value as the result.
    parallel  - run all listeners; collect exceptions but do not propagate
                (results are not meaningful for fire-and-forget observers).

Usage:
    from events import emit, serial, bail, waterfall, parallel
"""


def emit(listeners, *args, **kwargs):
    """Fire-and-forget. Listener exceptions are contained."""
    for fn in listeners:
        try:
            fn(*args, **kwargs)
        except Exception:
            # Observer failures must never break the loop (DSH: contained).
            continue


def serial(listeners, *args, **kwargs):
    """Run in registration order; stop at the first truthy return."""
    for fn in listeners:
        result = fn(*args, **kwargs)
        if result:
            return result
    return None


def bail(listeners, *args, **kwargs):
    """Sync single-decision dispatch: stop at the first truthy return."""
    return serial(listeners, *args, **kwargs)


def parallel(listeners, *args, **kwargs):
    """Run all listeners; exceptions contained, no meaningful result."""
    results = []
    for fn in listeners:
        try:
            results.append(fn(*args, **kwargs))
        except Exception:
            results.append(None)
    return results


def waterfall(listeners, initial, *args, **kwargs):
    """Around-middleware.

    Each listener is called as fn(value, next, *args). Call next() to delegate
    the current value, or next(new_value) to delegate a replacement. A listener
    that returns without calling next() short-circuits: the waterfall stops and
    the current value is the result.
    """
    value = initial
    for fn in listeners:
        state = {"called": False}

        def make_next(v=None):
            nonlocal value
            state["called"] = True
            if v is not None:
                value = v
            return value

        next_fn = make_next
        result = fn(value, next_fn, *args, **kwargs)
        if result is not None and not state["called"]:
            # A listener that returns a value without calling next() replaces
            # the value and short-circuits (documented convenience).
            return result
        if not state["called"]:
            # Listener vetoed by returning without next() and without a value:
            # short-circuit, current value wins.
            return value
    return value
