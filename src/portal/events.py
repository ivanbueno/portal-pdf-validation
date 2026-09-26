"""Structured one-line JSON logs. Never log paths, filenames, tokens, or exception messages."""

import json
import logging


def log_event(logger, event, level=logging.INFO, **fields):
    logger.log(level, json.dumps({"event": event, **fields}))
