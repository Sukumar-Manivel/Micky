"""Pure-ASGI middleware: internal-token auth, body size limit, request logging.

Why pure ASGI instead of ``@app.middleware("http")``? These run *before* the
request body is read. An unauthenticated caller is rejected without us ever
buffering its upload, and an oversized body is cut off mid-stream, even when
the client lies about (or omits) Content-Length.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
import uuid
from collections.abc import Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger("verifier.request")

PROTECTED_PREFIX = "/v1/"
TOKEN_HEADER = b"x-internal-token"


async def _send_json(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


def token_matches(provided: str | None, expected: str) -> bool:
    """Constant-time comparison of the shared secret.

    ``==`` stops at the first differing byte, so response timing leaks how many
    leading characters were right; ``secrets.compare_digest`` always compares
    every byte. An empty expected token never matches (fail closed).
    """
    if not expected or provided is None:
        return False
    return secrets.compare_digest(provided.encode(), expected.encode())


class InternalAuthMiddleware:
    """Require ``X-Internal-Token`` on every ``/v1/*`` route."""

    def __init__(self, app: ASGIApp, *, get_token: Callable[[], str]) -> None:
        self.app = app
        self.get_token = get_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"].startswith(PROTECTED_PREFIX):
            provided: str | None = None
            for name, value in scope["headers"]:
                if name == TOKEN_HEADER:
                    provided = value.decode("latin-1")
                    break
            if not token_matches(provided, self.get_token()):
                await _send_json(send, 401, "invalid or missing internal token")
                return
        await self.app(scope, receive, send)


class BodySizeLimitMiddleware:
    """Reject request bodies larger than ``max_bytes`` with 413."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        for name, value in scope["headers"]:
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                await _send_json(send, 413, "request body too large")
                return

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _BodyTooLargeError
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLargeError:
            if not response_started:
                await _send_json(send, 413, "request body too large")


class _BodyTooLargeError(Exception):
    pass


class RequestLogMiddleware:
    """One structured log line per request, with a request id and duration."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex[:12]
        scope.setdefault("state", {})["request_id"] = request_id
        start = time.perf_counter()
        status = 500

        async def capture_send(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", []).append((b"x-request-id", request_id.encode()))
            await send(message)

        try:
            await self.app(scope, receive, capture_send)
        finally:
            log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": scope["method"],
                    "path": scope["path"],
                    "status": status,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                },
            )
