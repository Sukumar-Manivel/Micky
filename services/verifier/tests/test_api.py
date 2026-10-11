"""End-to-end tests of the HTTP contract (docs/API.md, "Internal: worker -> verifier")."""

from __future__ import annotations

import re
from collections.abc import Callable

from fastapi.testclient import TestClient

from app.detector import FakeDetector
from tests.conftest import TOKEN, frame_files, make_image_bytes

HEX16 = re.compile(r"^[0-9a-f]{16}$")


def post(client: TestClient, headers: dict[str, str], files: list, media_type: str | None = "VIDEO"):  # type: ignore[type-arg]
    data = {"media_type": media_type} if media_type is not None else {}
    return client.post("/v1/analyze", headers=headers, data=data, files=files)


# --- auth -------------------------------------------------------------------


def test_missing_token_is_401(client: TestClient) -> None:
    r = post(client, {}, frame_files(make_image_bytes()))
    assert r.status_code == 401
    assert r.json() == {"detail": "invalid or missing internal token"}


def test_wrong_token_is_401(client: TestClient) -> None:
    r = post(client, {"X-Internal-Token": TOKEN + "x"}, frame_files(make_image_bytes()))
    assert r.status_code == 401


def test_empty_configured_token_rejects_everything(client_factory: Callable[..., TestClient]) -> None:
    from pydantic import SecretStr

    c = client_factory(FakeDetector(), internal_token=SecretStr(""))
    r = post(c, {"X-Internal-Token": ""}, frame_files(make_image_bytes()))
    assert r.status_code == 401


def test_health_needs_no_token(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "ai_model_loaded": True}


def test_health_reports_model_not_loaded_when_disabled(client_factory: Callable[..., TestClient]) -> None:
    c = client_factory(None)  # ai_model_enabled=False in the test settings
    assert c.get("/health").json() == {"status": "ok", "ai_model_loaded": False}


# --- validation -------------------------------------------------------------


def test_no_frames_is_400(client: TestClient, auth: dict[str, str]) -> None:
    r = client.post("/v1/analyze", headers=auth, data={"media_type": "PHOTO"})
    assert r.status_code == 400
    assert "frame" in r.json()["detail"]


def test_too_many_frames_is_400(client: TestClient, auth: dict[str, str]) -> None:
    blobs = [make_image_bytes(i) for i in range(17)]
    r = post(client, auth, frame_files(*blobs))
    assert r.status_code == 400


def test_sixteen_frames_is_ok(client: TestClient, auth: dict[str, str]) -> None:
    blobs = [make_image_bytes(i) for i in range(16)]
    r = post(client, auth, frame_files(*blobs))
    assert r.status_code == 200
    assert len(r.json()["phash"]) == 16


def test_non_image_frame_is_415(client: TestClient, auth: dict[str, str]) -> None:
    files = [("frames", ("evil.jpg", b"%PDF-1.7 definitely not a jpeg", "image/jpeg"))]
    r = post(client, auth, files)
    assert r.status_code == 415
    assert r.json() == {"detail": "frame 0 is not a valid JPEG or PNG image"}


def test_gif_frame_is_415(client: TestClient, auth: dict[str, str]) -> None:
    files = [("frames", ("x.gif", make_image_bytes(fmt="GIF"), "image/gif"))]
    assert post(client, auth, files).status_code == 415


def test_truncated_jpeg_is_415(client: TestClient, auth: dict[str, str]) -> None:
    blob = make_image_bytes(size=(400, 300))
    r = post(client, auth, frame_files(blob[: len(blob) // 2]))
    assert r.status_code == 415


def test_png_frame_is_accepted(client: TestClient, auth: dict[str, str]) -> None:
    files = [("frames", ("x.png", make_image_bytes(fmt="PNG"), "image/png"))]
    assert post(client, auth, files).status_code == 200


def test_missing_or_bad_media_type_is_400(client: TestClient, auth: dict[str, str]) -> None:
    assert post(client, auth, frame_files(make_image_bytes()), media_type=None).status_code == 400
    assert post(client, auth, frame_files(make_image_bytes()), media_type="AUDIO").status_code == 400


def test_frame_over_size_limit_is_413(
    client_factory: Callable[..., TestClient], auth: dict[str, str]
) -> None:
    c = client_factory(FakeDetector(), max_frame_bytes=2048)
    big = make_image_bytes(size=(600, 600))
    assert len(big) > 2048
    assert post(c, auth, frame_files(big)).status_code == 413


def test_decompression_bomb_is_413(client_factory: Callable[..., TestClient], auth: dict[str, str]) -> None:
    c = client_factory(FakeDetector(), max_image_pixels=10_000)
    # A 200x200 PNG of one colour is tiny on disk but 40,000 pixels when decoded.
    blob = make_image_bytes(size=(200, 200), fmt="PNG")
    files = [("frames", ("bomb.png", blob, "image/png"))]
    assert post(c, auth, files).status_code == 413


def test_whole_body_over_limit_is_413(
    client_factory: Callable[..., TestClient], auth: dict[str, str]
) -> None:
    c = client_factory(FakeDetector(), max_frames=1, max_frame_bytes=1024, max_original_bytes=1024)
    # Limit = 1*1024 + 1024 + 1 MiB; send ~1.5 MiB.
    files = [*frame_files(make_image_bytes()), ("original", ("o.bin", b"\0" * 1_500_000, "video/mp4"))]
    assert post(c, auth, files).status_code == 413


def test_original_over_limit_is_413(client_factory: Callable[..., TestClient], auth: dict[str, str]) -> None:
    c = client_factory(FakeDetector(), max_original_bytes=2048)
    files = [*frame_files(make_image_bytes()), ("original", ("o.mp4", b"\0" * 4096, "video/mp4"))]
    assert post(c, auth, files).status_code == 413


def test_errors_never_leak_tracebacks(client: TestClient, auth: dict[str, str]) -> None:
    r = post(client, auth, [("frames", ("x.jpg", b"\xff\xd8garbage", "image/jpeg"))])
    assert "Traceback" not in r.text
    assert set(r.json()) == {"detail"}


# --- response shape and aggregation ----------------------------------------


def test_response_shape_matches_contract(client: TestClient, auth: dict[str, str]) -> None:
    r = post(client, auth, frame_files(make_image_bytes(0), make_image_bytes(1), make_image_bytes(2)))
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ai", "c2pa", "phash"}
    assert set(body["ai"]) == {"available", "score", "model", "frames_scored", "frame_scores"}
    assert set(body["c2pa"]) == {"status", "issuer", "claim_generator"}
    assert body["c2pa"] == {"status": "unsupported", "issuer": None, "claim_generator": None}
    assert isinstance(body["ai"]["available"], bool)
    assert isinstance(body["ai"]["score"], float)
    assert body["ai"]["model"] == "fake-detector"
    assert len(body["phash"]) == 3
    assert all(HEX16.match(h) for h in body["phash"])
    assert r.headers["x-request-id"]


def test_fake_scores_are_aggregated_with_median(client: TestClient, auth: dict[str, str]) -> None:
    # FakeDetector scores in order: 0.1, 0.9, 0.3, 0.8, 0.2 -> median 0.3
    blobs = [make_image_bytes(i) for i in range(5)]
    ai = post(client, auth, frame_files(*blobs)).json()["ai"]
    assert ai["available"] is True
    assert ai["frames_scored"] == 5
    assert ai["frame_scores"] == [0.1, 0.9, 0.3, 0.8, 0.2]
    assert ai["score"] == 0.3


def test_even_number_of_frames_uses_mean_of_middle_two(client: TestClient, auth: dict[str, str]) -> None:
    # 0.1, 0.9, 0.3, 0.8 -> sorted 0.1 0.3 0.8 0.9 -> (0.3 + 0.8) / 2
    blobs = [make_image_bytes(i) for i in range(4)]
    ai = post(client, auth, frame_files(*blobs)).json()["ai"]
    assert abs(ai["score"] - 0.55) < 1e-9


def test_model_disabled_gives_unavailable(
    client_factory: Callable[..., TestClient], auth: dict[str, str]
) -> None:
    c = client_factory(None)
    body = post(c, auth, frame_files(make_image_bytes())).json()
    assert body["ai"] == {
        "available": False,
        "score": None,
        "model": None,
        "frames_scored": 0,
        "frame_scores": [],
    }
    assert len(body["phash"]) == 1  # the rest of the analysis still runs


def test_detector_crash_gives_unavailable_not_500(
    client_factory: Callable[..., TestClient], auth: dict[str, str]
) -> None:
    class Exploding(FakeDetector):
        def predict(self, images):  # type: ignore[no-untyped-def]
            raise RuntimeError("boom")

    c = client_factory(Exploding())
    r = post(c, auth, frame_files(make_image_bytes()))
    assert r.status_code == 200
    assert r.json()["ai"]["available"] is False


def test_phash_order_matches_frame_order(client: TestClient, auth: dict[str, str]) -> None:
    a, b = make_image_bytes(0), make_image_bytes(1)
    first = post(client, auth, frame_files(a, b)).json()["phash"]
    second = post(client, auth, frame_files(b, a)).json()["phash"]
    assert first == list(reversed(second))
    assert first[0] != first[1]


def test_c2pa_absent_for_plain_jpeg_original(client: TestClient, auth: dict[str, str]) -> None:
    blob = make_image_bytes()
    files = [*frame_files(blob), ("original", ("orig.jpg", blob, "image/jpeg"))]
    body = post(client, auth, files, media_type="PHOTO").json()
    assert body["c2pa"] == {"status": "absent", "issuer": None, "claim_generator": None}


def test_c2pa_error_for_garbage_original(client: TestClient, auth: dict[str, str]) -> None:
    files = [*frame_files(make_image_bytes()), ("original", ("o.mp4", b"\0" * 512, "video/mp4"))]
    r = post(client, auth, files)
    assert r.status_code == 200
    assert r.json()["c2pa"]["status"] == "error"


def test_slow_model_load_times_out_gracefully(
    client_factory: Callable[..., TestClient], auth: dict[str, str]
) -> None:
    import threading

    gate = threading.Event()

    class SlowLoad(FakeDetector):
        def load(self) -> None:
            gate.wait(5)
            super().load()

    c = client_factory(SlowLoad(), model_load_wait_seconds=0.05)
    r = post(c, auth, frame_files(make_image_bytes()))
    gate.set()
    assert r.status_code == 200
    assert r.json()["ai"]["available"] is False
