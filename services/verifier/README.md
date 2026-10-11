# FirstFrame verifier

Internal Python service that the API worker calls for every upload. It returns
**evidence**, not a verdict:

| Check | What it returns | Library |
|---|---|---|
| AI-likelihood | P(AI-generated) per frame + median | `transformers` ViT, `dima806/ai_vs_human_generated_image_detection` (Apache-2.0) |
| Provenance | C2PA manifest status, issuer, claim generator | `c2pa-python` 0.38 (c2pa-rs 0.91) |
| Near-duplicates | 64-bit pHash per frame (16 hex chars) | `ImageHash` |

Contract: `docs/API.md`, section "Internal: worker → verifier service".
Learning notes: `docs/learning/verifier.md`.

## Endpoints

```
POST /v1/analyze     X-Internal-Token required; multipart: media_type, frames (1..16), original?
GET  /health         {"status": "ok", "ai_model_loaded": bool}   (no token, for Docker healthchecks)
```

Errors are always `{"detail": "..."}`: 400 bad input, 401 bad token, 413 too large,
415 not JPEG/PNG, 500 `"internal error"` (details only in the logs).

## Run locally

```bash
cd services/verifier
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

# Tests (no model, no network needed)
.venv/bin/python -m pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .

# Run without the AI model
INTERNAL_TOKEN=devtoken AI_MODEL_ENABLED=false \
  .venv/bin/uvicorn --factory app.main:app_factory --port 8000 --reload

curl localhost:8000/health
curl -H "X-Internal-Token: devtoken" -F media_type=PHOTO -F frames=@photo.jpg \
     -F original=@photo.jpg localhost:8000/v1/analyze
```

### With the real model

```bash
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
.venv/bin/pip install -r requirements-ml.txt
INTERNAL_TOKEN=devtoken .venv/bin/uvicorn --factory app.main:app_factory --port 8000
```

The first start downloads ~345 MB from Hugging Face; `/health` reports
`ai_model_loaded: false` until it's ready. Requests that arrive while the model is
loading wait up to `MODEL_LOAD_WAIT_SECONDS` and then answer with `ai.available=false`.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `INTERNAL_TOKEN` | *(empty)* | Shared secret with the API. Empty = every `/v1` request is rejected. |
| `AI_MODEL_ENABLED` | `true` | `false` skips torch entirely (`ai.available=false`). |
| `AI_MODEL_ID` | `dima806/ai_vs_human_generated_image_detection` | |
| `AI_MODEL_REVISION` | `341594f2…` | Pinned Hugging Face commit. |
| `TORCH_THREADS` | `2` | Matches the 2-OCPU server. |
| `MODEL_LOAD_WAIT_SECONDS` | `60` | |
| `MAX_FRAMES` | `16` | |
| `MAX_FRAME_BYTES` | `8388608` (8 MB) | Per frame. |
| `MAX_ORIGINAL_BYTES` | `52428800` (50 MB) | |
| `MAX_IMAGE_PIXELS` | `40000000` | Decompression-bomb guard. |
| `LOG_LEVEL` | `INFO` | JSON lines on stdout. |

## Docker

```bash
docker build -t firstframe-verifier services/verifier             # bakes in the model
docker build --build-arg PRELOAD_MODEL=false -t firstframe-verifier services/verifier
docker run --rm -p 8000:8000 -e INTERNAL_TOKEN=... firstframe-verifier
```

`python:3.12-slim`, CPU-only torch from the PyTorch index, non-root user (uid 10001),
`HEALTHCHECK` on `/health`, one uvicorn worker. All pinned dependencies have
`linux/aarch64` wheels, so it builds natively on the Oracle Ampere server. Expect
~1.2 GB RAM with the model loaded.

The container should only be reachable on the internal Docker network, never published
to the internet. The token is a second layer, not the only one.

## Dependency files

- `pyproject.toml`: metadata, loose ranges, pytest and ruff config.
- `requirements.txt`: exact runtime pins (used by Docker).
- `requirements-ml.txt`: `transformers` pin; torch is installed separately from the CPU index.
- `requirements-dev.txt`: runtime + pytest, httpx, ruff, cryptography (signs test C2PA files).

## Known limitations / follow-ups

- **No C2PA trust list yet.** A correctly signed manifest from an unknown signer is
  reported as `valid` with its `issuer`. Load the official C2PA trust list
  (`trust.trust_anchors` setting) to tell "signed by Google/Samsung" from "signed by anyone".
- The AI score is weak evidence (see `docs/RESEARCH.md`): it must never auto-reject.
- Video originals are only checked for C2PA; frames are extracted by the API worker.
