"""AI-generated image detector.

The real detector is a Vision Transformer (ViT-Base/16) fine-tuned by the model
author to classify images as ``human`` vs ``AI-generated``. Its config.json says:

    "id2label": {"0": "human", "1": "AI-generated"}

so P(AI) is the softmax probability of the label ``AI-generated``. We look the
label up by *name* at load time (and refuse to run if it's missing) instead of
assuming "index 1 = AI", so swapping in another model can't silently invert
the scores.

Design:
* ``Detector`` is a Protocol (an interface). The app only depends on it, so the
  tests inject a ``FakeDetector`` and never need torch or the network.
* ``HuggingFaceDetector`` imports torch/transformers lazily inside ``load()``:
  the service still starts (with ``available=false``) if those heavy packages
  are absent or the download fails.
* Inference is CPU-bound and blocking. The route calls it via
  ``run_in_threadpool`` so the asyncio event loop keeps serving /health, and a
  lock serialises calls because the box has only 2 cores (parallel forward
  passes would just fight over them and use 2x the RAM).
"""

from __future__ import annotations

import logging
import statistics
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from PIL import Image

log = logging.getLogger(__name__)

# Exact label name for "AI-generated" in dima806/ai_vs_human_generated_image_detection.
DEFAULT_AI_LABEL = "AI-generated"


@runtime_checkable
class Detector(Protocol):
    """Anything that can turn images into P(AI-generated) scores."""

    @property
    def loaded(self) -> bool: ...

    @property
    def model_id(self) -> str: ...

    def load(self) -> None:
        """Load weights. Must not raise; on failure ``loaded`` stays False."""

    def predict(self, images: Sequence[Image.Image]) -> list[float]:
        """Return one probability in [0, 1] per image, same order."""


@dataclass(frozen=True)
class AiScores:
    """Aggregated detector output for one request."""

    available: bool
    score: float | None
    model: str | None
    frame_scores: list[float]


def aggregate(frame_scores: Sequence[float]) -> float | None:
    """Combine per-frame scores into one number: the median.

    Why the median and not the mean? One odd frame (motion blur, a black
    frame at a cut, a heavily compressed frame) can get an extreme score.
    The median ignores a minority of outliers; the mean would be dragged by them.
    The worker also gets every per-frame score, so it can compute other views
    (e.g. the mean of the top 3, to catch a short AI-generated insert).
    """
    if not frame_scores:
        return None
    return float(statistics.median(frame_scores))


def score_frames(detector: Detector | None, frames: Sequence[Image.Image]) -> AiScores:
    """Run the detector and aggregate. Never raises: failures mean available=False."""
    if detector is None or not detector.loaded:
        return AiScores(available=False, score=None, model=None, frame_scores=[])
    try:
        scores = [round(min(1.0, max(0.0, float(s))), 6) for s in detector.predict(frames)]
    except Exception as exc:  # A bad frame must not take the whole request down.
        log.warning("ai detector failed", extra={"error_type": type(exc).__name__})
        return AiScores(available=False, score=None, model=None, frame_scores=[])
    if len(scores) != len(frames):
        log.error("detector returned %d scores for %d frames", len(scores), len(frames))
        return AiScores(available=False, score=None, model=None, frame_scores=[])
    return AiScores(available=True, score=aggregate(scores), model=detector.model_id, frame_scores=scores)


class HuggingFaceDetector:
    """Detector backed by a transformers image-classification pipeline on CPU."""

    def __init__(
        self,
        model_id: str,
        *,
        revision: str | None = None,
        ai_label: str = DEFAULT_AI_LABEL,
        threads: int = 2,
        batch_size: int = 4,
    ) -> None:
        self._model_id = model_id
        self._revision = revision
        self._ai_label = ai_label
        self._threads = threads
        self._batch_size = batch_size
        self._pipe: Any = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._pipe is not None

    @property
    def model_id(self) -> str:
        return self._model_id

    def load(self) -> None:
        if self._pipe is not None:
            return
        try:
            import torch
            from transformers import pipeline

            torch.set_num_threads(self._threads)
            pipe = pipeline(
                "image-classification",
                model=self._model_id,
                revision=self._revision,
                device=-1,  # CPU
            )
            id2label: dict[int, str] = dict(pipe.model.config.id2label)
            if self._ai_label not in id2label.values():
                raise ValueError(f"label {self._ai_label!r} not in model labels {id2label}")
            self._pipe = pipe
            log.info("ai model loaded", extra={"model": self._model_id, "labels": id2label})
        except Exception as exc:
            # Missing packages, no network, bad revision, out of memory, ...
            log.error(
                "ai model failed to load; continuing with ai.available=false",
                extra={"model": self._model_id, "error_type": type(exc).__name__, "error": str(exc)[:300]},
            )
            self._pipe = None

    def predict(self, images: Sequence[Image.Image]) -> list[float]:
        if self._pipe is None:
            raise RuntimeError("model not loaded")
        num_labels = int(self._pipe.model.config.num_labels)
        with self._lock:
            # Ask for every label (top_k=num_labels) and be explicit that the
            # raw logits go through softmax, so the scores of all labels sum to 1.
            outputs = self._pipe(
                list(images), top_k=num_labels, function_to_apply="softmax", batch_size=self._batch_size
            )
        scores: list[float] = []
        for per_image in outputs:
            by_label = {item["label"]: float(item["score"]) for item in per_image}
            scores.append(by_label[self._ai_label])
        return scores


class FakeDetector:
    """Deterministic detector for tests and local development.

    Returns the given scores in order (cycling if there are more frames).
    """

    def __init__(self, scores: Sequence[float] = (0.5,), *, model_id: str = "fake-detector") -> None:
        self._scores = list(scores)
        self._model_id = model_id
        self._loaded = False
        self.calls = 0

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def model_id(self) -> str:
        return self._model_id

    def load(self) -> None:
        self._loaded = True

    def predict(self, images: Sequence[Image.Image]) -> list[float]:
        self.calls += 1
        return [self._scores[i % len(self._scores)] for i in range(len(images))]
