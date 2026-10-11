"""Unit tests for pHash, aggregation, frame decoding and token comparison."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.detector import FakeDetector, aggregate, score_frames
from app.images import FrameError, decode_frame
from app.middleware import token_matches
from app.phash import hamming_distance, phash_hex
from tests.conftest import make_image_bytes


def _open(blob: bytes) -> Image.Image:
    return Image.open(io.BytesIO(blob)).convert("RGB")


# --- pHash ------------------------------------------------------------------


def test_phash_is_16_hex_chars() -> None:
    h = phash_hex(_open(make_image_bytes()))
    assert len(h) == 16
    int(h, 16)  # parses as hex


def test_phash_stable_for_identical_images() -> None:
    blob = make_image_bytes(4)
    assert phash_hex(_open(blob)) == phash_hex(_open(blob))


def test_phash_close_for_reencoded_and_resized_copy() -> None:
    original = _open(make_image_bytes(4, size=(320, 240)))
    buf = io.BytesIO()
    original.resize((160, 120)).save(buf, "JPEG", quality=40)
    copy = _open(buf.getvalue())
    assert hamming_distance(phash_hex(original), phash_hex(copy)) <= 8


def test_phash_differs_for_different_images() -> None:
    a = phash_hex(_open(make_image_bytes(0)))
    b = phash_hex(_open(make_image_bytes(1)))
    assert a != b
    assert hamming_distance(a, b) > 8


# --- aggregation ------------------------------------------------------------


@pytest.mark.parametrize(
    ("scores", "expected"),
    [([], None), ([0.7], 0.7), ([0.1, 0.2, 0.99], 0.2), ([0.2, 0.4], pytest.approx(0.3))],
)
def test_aggregate_median(scores: list[float], expected: object) -> None:
    assert aggregate(scores) == expected


def test_score_frames_without_detector() -> None:
    result = score_frames(None, [Image.new("RGB", (8, 8))])
    assert (result.available, result.score, result.model, result.frame_scores) == (False, None, None, [])


def test_score_frames_unloaded_detector_is_unavailable() -> None:
    det = FakeDetector([0.9])  # load() not called
    assert score_frames(det, [Image.new("RGB", (8, 8))]).available is False


def test_score_frames_clamps_out_of_range() -> None:
    det = FakeDetector([1.5, -0.2])
    det.load()
    result = score_frames(det, [Image.new("RGB", (8, 8))] * 2)
    assert result.frame_scores == [1.0, 0.0]


# --- frame decoding ---------------------------------------------------------


def test_decode_frame_returns_rgb() -> None:
    img = decode_frame(make_image_bytes(fmt="PNG"), index=0, max_bytes=10**7, max_pixels=10**7)
    assert img.mode == "RGB"


@pytest.mark.parametrize(
    ("blob", "status"),
    [(b"", 400), (b"hello", 415), (make_image_bytes(fmt="BMP"), 415)],
)
def test_decode_frame_rejects(blob: bytes, status: int) -> None:
    with pytest.raises(FrameError) as info:
        decode_frame(blob, index=2, max_bytes=10**7, max_pixels=10**7)
    assert info.value.status_code == status


# --- token comparison -------------------------------------------------------


def test_token_matches() -> None:
    assert token_matches("abc", "abc")
    assert not token_matches("abd", "abc")
    assert not token_matches(None, "abc")
    assert not token_matches("", "")  # empty configured token never matches
    assert not token_matches("ab", "abc")


# --- real detector wrapper (no torch / network needed) ----------------------


def test_hf_detector_load_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.detector import HuggingFaceDetector

    # Never touch the network from tests, even if torch happens to be installed.
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    det = HuggingFaceDetector("firstframe/does-not-exist")
    det.load()  # must not raise
    assert det.loaded is False
    assert score_frames(det, [Image.new("RGB", (8, 8))]).available is False
