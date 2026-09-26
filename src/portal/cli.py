"""Shared entry point for the worker and maintenance processes."""

import argparse
import logging
import time
from .config import Settings
from .storage import Storage


def run(step, interval):
    """Run `step(store, settings)` once, or every `interval` seconds with --loop."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("azure").setLevel(logging.WARNING)
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    store = Storage(settings)
    store.initialize()
    while True:
        step(store, settings)
        if not args.loop:
            return
        time.sleep(interval)
