"""Cooperative stop for in-flight gate runs (Ctrl-C / SIGTERM).

Signals reach only the main thread. When it is interrupted while a gate is evaluating, ``ratchet.gate``
sets :data:`STOP` and waits for its worker threads. Every worker checks the flag before each model call
(``ratchet.llm`` also wakes from throttle/backoff sleeps), so a thread finishes its current HTTP request at
most and then stops. Runs that stop this way are discarded rather than saved as scored failures, so a later
``ratchet run`` re-runs them.
"""
from __future__ import annotations

import threading

STOP = threading.Event()


class RunInterrupted(Exception):
    """Raised inside a worker thread once a stop was requested; the run is not scored."""


def stop_requested() -> bool:
    return STOP.is_set()


def check() -> None:
    if STOP.is_set():
        raise RunInterrupted("stop requested")


def sleep(seconds: float) -> None:
    """time.sleep that returns early (raising RunInterrupted) when a stop is requested."""
    if seconds <= 0:
        check()
        return
    if STOP.wait(seconds):
        raise RunInterrupted("stop requested")


def request_stop() -> None:
    STOP.set()


def clear() -> None:
    STOP.clear()
