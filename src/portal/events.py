"""Structured one-line JSON logs. Never log paths, filenames, tokens, or exception messages."""

import json
import logging


def configure_logging():
    """Every process writes these events to stderr; Azure SDK request chatter only from warnings."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("azure").setLevel(logging.WARNING)


def log_event(logger, event, level=logging.INFO, **fields):
    logger.log(level, json.dumps({"event": event, **fields}))
