"""Response models. These mirror docs/API.md "Internal: worker -> verifier service" exactly.

``extra="forbid"`` means a typo'd field name is a bug caught by tests rather than
a silent change to the contract the Node worker depends on.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MediaType(StrEnum):
    VIDEO = "VIDEO"
    PHOTO = "PHOTO"


C2paStatus = Literal["valid", "invalid", "absent", "error", "unsupported"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AiResult(_Strict):
    available: bool
    score: float | None = Field(description="Median P(AI-generated) over frames, 0..1")
    model: str | None
    frames_scored: int
    frame_scores: list[float]


class C2paResult(_Strict):
    status: C2paStatus
    issuer: str | None = None
    claim_generator: str | None = None


class AnalyzeResponse(_Strict):
    ai: AiResult
    c2pa: C2paResult
    phash: list[str] = Field(description="16 hex chars per frame, same order as the frames")


class HealthResponse(_Strict):
    status: Literal["ok"]
    ai_model_loaded: bool


class ErrorResponse(_Strict):
    """Error body. Matches FastAPI's default ``{"detail": ...}`` shape."""

    detail: str
