"""Shared entry point for the worker and maintenance processes."""

import argparse
import logging
import time
from .config import Settings
from .events import configure_logging, log_event
from .storage import Storage

log = logging.getLogger("portal.cli")


def run(step, interval):
    """Run `step(store, settings)` once, or every `interval` seconds with --loop.

    A single run lets failures propagate, so the Azure job execution reports them. The loop
    logs a failed step and keeps going: one storage hiccup must not stop local processing.
    """
    configure_logging()
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    store = Storage(settings)
    store.initialize()
    if not args.loop:
        step(store, settings)
        return
    while True:
        try:
            step(store, settings)
        except Exception as exc:
            log_event(log, "step_failed", logging.ERROR, step=step.__name__, type=type(exc).__name__)
        time.sleep(interval)
