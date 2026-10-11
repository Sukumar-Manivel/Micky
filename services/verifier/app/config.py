"""Service configuration, read once from environment variables.

We use pydantic-settings so every value is typed and validated at startup:
a typo such as ``MAX_FRAMES=sixteen`` fails fast instead of at the first request.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

MB = 1024 * 1024


class Settings(BaseSettings):
    """All tunables for the verifier. Env var names are the upper-case field names."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Shared secret the API worker sends in the X-Internal-Token header.
    # SecretStr keeps it out of logs and reprs. An empty value means "refuse
    # every request" (see auth.py), so a misconfigured deploy fails closed.
    internal_token: SecretStr = SecretStr("")

    # AI detector. Disable it to run on tiny machines or in tests.
    ai_model_enabled: bool = True
    ai_model_id: str = "dima806/ai_vs_human_generated_image_detection"
    # Pin a Hugging Face commit so the model can't change underneath us
    # (latest commit on 2026-10-10). Set to "main" to always take the newest.
    ai_model_revision: str | None = "341594f2b003d185db789becf48a2286c177b926"
    # torch intra-op threads. The production box has 2 OCPUs.
    torch_threads: int = Field(default=2, ge=1, le=64)
    # How long an /analyze request waits for a still-loading model before
    # answering with ai.available=false (the worker can retry later).
    model_load_wait_seconds: float = Field(default=60.0, ge=0)

    # Request limits (the worker samples at most 16 frames, see docs/API.md).
    max_frames: int = Field(default=16, ge=1, le=64)
    max_frame_bytes: int = Field(default=8 * MB, ge=1024)
    max_original_bytes: int = Field(default=50 * MB, ge=1024)
    # Frames larger than this many pixels are rejected (decompression bombs).
    max_image_pixels: int = Field(default=40_000_000, ge=10_000)

    log_level: str = "INFO"

    @property
    def max_request_bytes(self) -> int:
        """Upper bound for the whole multipart body (all frames + original + slack)."""
        return self.max_frames * self.max_frame_bytes + self.max_original_bytes + MB


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide settings (cached, so env is read only once)."""
    return Settings()
