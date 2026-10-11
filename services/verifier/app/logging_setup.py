"""Structured (JSON-lines) logging using only the standard library.

One JSON object per line is easy to grep and is understood by Docker log
drivers, Loki, CloudWatch and friends. Anything passed via ``extra={...}``
becomes a top-level key.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

# Attributes every LogRecord has; anything else came from ``extra=``.
_STANDARD_ATTRS: frozenset[str] = frozenset(
    vars(logging.LogRecord("", 0, "", 0, "", None, None)).keys() | {"message", "asctime", "taskName"}
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            # Stack traces go to *our* logs only, never to HTTP clients.
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Uvicorn's access log duplicates our own request log line.
    logging.getLogger("uvicorn.access").disabled = True
