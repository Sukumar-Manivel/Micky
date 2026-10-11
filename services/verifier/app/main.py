"""FastAPI application: POST /v1/analyze and GET /health.

Request flow for /v1/analyze (see docs/learning/verifier.md for the long version):

    RequestLogMiddleware      -> request id + one log line per request
    BodySizeLimitMiddleware   -> 413 if the body is too big (before parsing it)
    InternalAuthMiddleware    -> 401 unless X-Internal-Token matches (constant time)
    analyze()                 -> parse multipart, validate frames with Pillow,
                                 then in worker threads: AI scores, C2PA, pHash
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from PIL import Image
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException

from app import __version__
from app.c2pa_check import C2PA_VERSION, check_c2pa
from app.config import Settings, get_settings
from app.detector import Detector, HuggingFaceDetector, score_frames
from app.images import FrameError, configure_pillow, decode_frame
from app.logging_setup import configure_logging
from app.middleware import BodySizeLimitMiddleware, InternalAuthMiddleware, RequestLogMiddleware
from app.phash import phash_frames
from app.schemas import AiResult, AnalyzeResponse, ErrorResponse, HealthResponse, MediaType

log = logging.getLogger("verifier")


class ApiError(Exception):
    """An expected client error with a safe, human-readable message."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _build_detector(settings: Settings) -> Detector | None:
    if not settings.ai_model_enabled:
        return None
    return HuggingFaceDetector(
        settings.ai_model_id, revision=settings.ai_model_revision, threads=settings.torch_threads
    )


def create_app(settings: Settings | None = None, detector: Detector | None = None) -> FastAPI:
    """Application factory. Tests pass their own settings and a fake detector."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    configure_pillow(settings.max_image_pixels)
    if detector is None:
        detector = _build_detector(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if not settings.internal_token.get_secret_value():
            log.warning("INTERNAL_TOKEN is empty: every /v1 request will be rejected")
        # Load the model in a background thread so the server (and /health)
        # comes up immediately; downloading ~350 MB can take a while.
        load_task: asyncio.Task[None] | None = None
        if detector is not None:
            load_task = asyncio.create_task(asyncio.to_thread(detector.load))
        app.state.load_task = load_task
        log.info("verifier started", extra={"version": __version__, "c2pa_sdk": C2PA_VERSION})
        yield
        if load_task is not None and not load_task.done():
            load_task.cancel()

    app = FastAPI(
        title="Micky verifier",
        version=__version__,
        lifespan=lifespan,
        # Internal service: no public API docs.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.detector = detector
    app.state.load_task = None

    # Middleware added last runs first: log -> size limit -> auth -> route.
    app.add_middleware(InternalAuthMiddleware, get_token=lambda: settings.internal_token.get_secret_value())
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_bytes)
    app.add_middleware(RequestLogMiddleware)

    _register_error_handlers(app)
    _register_routes(app)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    """Map every failure to ``{"detail": "..."}`` and never leak stack traces."""

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"detail": str(exc.detail)}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "invalid request"}, status_code=400)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception(
            "unhandled error", extra={"request_id": request.scope.get("state", {}).get("request_id")}
        )
        return JSONResponse({"detail": "internal error"}, status_code=500)


async def _wait_for_model(app: FastAPI, timeout_s: float) -> None:
    """If the model is still loading, wait a bounded time rather than skip AI scoring.

    ``shield`` stops a timed-out request from cancelling the shared load task;
    after the timeout this request just reports ``ai.available=false``.
    """
    task: asyncio.Task[None] | None = app.state.load_task
    if task is not None and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=timeout_s)
        except TimeoutError:
            log.warning("ai model still loading; scoring skipped for this request")


async def _read_frames(files: list[UploadFile], settings: Settings) -> list[Image.Image]:
    images: list[Image.Image] = []
    for index, upload in enumerate(files):
        # Read one byte more than allowed so we can tell "exactly at limit" from "over".
        data = await upload.read(settings.max_frame_bytes + 1)
        try:
            images.append(
                decode_frame(
                    data,
                    index=index,
                    max_bytes=settings.max_frame_bytes,
                    max_pixels=settings.max_image_pixels,
                )
            )
        except FrameError as exc:
            raise ApiError(exc.status_code, str(exc)) from exc
    return images


def _register_routes(app: FastAPI) -> None:
    settings: Settings = app.state.settings

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        detector: Detector | None = app.state.detector
        return HealthResponse(status="ok", ai_model_loaded=bool(detector and detector.loaded))

    @app.post(
        "/v1/analyze",
        response_model=AnalyzeResponse,
        responses={code: {"model": ErrorResponse} for code in (400, 401, 413, 415)},
    )
    async def analyze(request: Request) -> AnalyzeResponse:
        # We parse the multipart body ourselves (instead of File()/Form()
        # parameters) so we can cap the number of parts and fields up front.
        try:
            form = await request.form(max_files=settings.max_frames + 1, max_fields=8)
        except MultiPartException as exc:
            raise ApiError(400, f"invalid multipart body: {exc.message}") from exc

        try:
            media_type = _parse_media_type(form.get("media_type"))
            frame_parts = form.getlist("frames")
            if not frame_parts:
                raise ApiError(400, "at least one frame is required")
            if len(frame_parts) > settings.max_frames:
                raise ApiError(400, f"at most {settings.max_frames} frames are allowed")
            if not all(isinstance(p, UploadFile) for p in frame_parts):
                raise ApiError(400, "frames must be files")
            frame_files: list[UploadFile] = [p for p in frame_parts if isinstance(p, UploadFile)]

            original = form.get("original")
            if original is not None and not isinstance(original, UploadFile):
                raise ApiError(400, "original must be a file")
            if original is not None and (original.size or 0) > settings.max_original_bytes:
                raise ApiError(413, f"original exceeds {settings.max_original_bytes} bytes")

            frames = await _read_frames(frame_files, settings)
            await _wait_for_model(app, settings.model_load_wait_seconds)

            # The three checks are independent and CPU-bound: run them in the
            # threadpool concurrently so the event loop stays free.
            ai, c2pa_result, hashes = await asyncio.gather(
                run_in_threadpool(score_frames, app.state.detector, frames),
                run_in_threadpool(
                    check_c2pa,
                    original.file if original is not None else None,
                    original.content_type if original is not None else None,
                ),
                run_in_threadpool(phash_frames, frames),
            )
        finally:
            await form.close()  # Deletes spooled temp files right away.

        log.info(
            "analyzed",
            extra={
                "media_type": media_type.value,
                "frames": len(frames),
                "ai_available": ai.available,
                "ai_score": ai.score,
                "c2pa": c2pa_result.status,
            },
        )
        return AnalyzeResponse(
            ai=AiResult(
                available=ai.available,
                score=ai.score,
                model=ai.model,
                frames_scored=len(ai.frame_scores),
                frame_scores=ai.frame_scores,
            ),
            c2pa=c2pa_result,
            phash=hashes,
        )


def _parse_media_type(value: object) -> MediaType:
    if not isinstance(value, str):
        raise ApiError(400, "media_type is required (VIDEO or PHOTO)")
    try:
        return MediaType(value)
    except ValueError as exc:
        raise ApiError(400, "media_type must be VIDEO or PHOTO") from exc


def app_factory() -> FastAPI:
    """Entry point for ``uvicorn --factory app.main:app_factory``."""
    return create_app()
