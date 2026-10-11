"""Shared fixtures. No test needs the real model or the network."""

from __future__ import annotations

import io
from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from pydantic import SecretStr

from app.config import Settings
from app.detector import FakeDetector
from app.main import create_app

TOKEN = "test-internal-token-0123456789"


def make_image_bytes(seed: int = 0, *, size: tuple[int, int] = (128, 96), fmt: str = "JPEG") -> bytes:
    """Draw a deterministic test picture. Different seeds give visually different images."""
    img = Image.new("RGB", size, (20 + seed * 37 % 200, 40, 90))
    draw = ImageDraw.Draw(img)
    w, h = size
    if seed % 2 == 0:
        draw.rectangle([w // 8, h // 8, w // 2, h - h // 8], fill=(240, 240, 240))
    else:
        draw.ellipse([w // 3, 0, w, h // 2], fill=(250, 220, 30))
        draw.line([0, h, w, 0], fill=(0, 0, 0), width=6)
    buf = io.BytesIO()
    img.save(buf, fmt)
    return buf.getvalue()


@pytest.fixture
def settings() -> Settings:
    return Settings(
        internal_token=SecretStr(TOKEN),
        ai_model_enabled=False,
        max_frame_bytes=2 * 1024 * 1024,
        max_original_bytes=4 * 1024 * 1024,
    )


@pytest.fixture
def fake_detector() -> FakeDetector:
    return FakeDetector([0.1, 0.9, 0.3, 0.8, 0.2])


@pytest.fixture
def client_factory(settings: Settings) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def make(detector: FakeDetector | None = None, **overrides: object) -> TestClient:
        s = settings.model_copy(update=overrides) if overrides else settings
        client = TestClient(create_app(s, detector=detector), raise_server_exceptions=False)
        client.__enter__()  # runs the lifespan (loads the fake detector)
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(client_factory: Callable[..., TestClient], fake_detector: FakeDetector) -> TestClient:
    return client_factory(fake_detector)


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-Internal-Token": TOKEN}


def frame_files(*blobs: bytes, name: str = "frames") -> list[tuple[str, tuple[str, bytes, str]]]:
    return [(name, (f"f{i}.jpg", b, "image/jpeg")) for i, b in enumerate(blobs)]
