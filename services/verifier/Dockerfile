# Micky verifier: FastAPI + CPU-only PyTorch, for linux/arm64 (Oracle Ampere) and amd64.
#
# Build:  docker build -t micky-verifier services/verifier
# Run:    docker run --rm -p 8000:8000 -e INTERNAL_TOKEN=... micky-verifier
#
# The model weights (~345 MB) are downloaded at BUILD time into the image, at a
# pinned commit, so the running container never needs Hugging Face (and can run
# with HF_HUB_OFFLINE=1). Pass --build-arg PRELOAD_MODEL=false for a small image
# that runs with AI_MODEL_ENABLED=false or downloads on first start.
# Pass --build-arg WITH_ML=false for a lite image without torch/transformers
# (~150 MB instead of ~1 GB): C2PA and perceptual hashes still work, and the AI
# score is reported as unavailable. Local docker-compose uses this.

FROM python:3.14-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

WORKDIR /app

# 1) CPU-only torch from the PyTorch index. From plain PyPI, x86 builds pull
#    ~3 GB of CUDA libraries we can't use on a CPU-only server.
ARG WITH_ML=true
ARG TORCH_VERSION=2.14.1
RUN if [ "$WITH_ML" = "true" ]; then \
      pip install --index-url https://download.pytorch.org/whl/cpu "torch==${TORCH_VERSION}"; \
    fi

# 2) Everything else. Copied separately so code changes don't reinstall deps.
COPY requirements.txt requirements-ml.txt ./
RUN pip install -r requirements.txt \
    && if [ "$WITH_ML" = "true" ]; then pip install -r requirements-ml.txt; fi

# 3) Model weights, pinned to a commit so a model update can't change scores silently.
ARG PRELOAD_MODEL=true
ARG AI_MODEL_ID=dima806/ai_vs_human_generated_image_detection
ARG AI_MODEL_REVISION=341594f2b003d185db789becf48a2286c177b926
RUN if [ "$WITH_ML" = "true" ] && [ "$PRELOAD_MODEL" = "true" ]; then \
      python -c "from huggingface_hub import snapshot_download; snapshot_download('${AI_MODEL_ID}', revision='${AI_MODEL_REVISION}', allow_patterns=['config.json', 'preprocessor_config.json', 'model.safetensors'])"; \
    fi

# 4) Unprivileged user: a bug in an image decoder can't touch root-owned files.
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin verifier \
    && mkdir -p /models && chown -R verifier:verifier /models

COPY --chown=verifier:verifier app ./app

ENV AI_MODEL_ID=${AI_MODEL_ID} \
    AI_MODEL_REVISION=${AI_MODEL_REVISION} \
    HF_HUB_OFFLINE=1 \
    OMP_NUM_THREADS=2

USER verifier
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

# One worker: the model is ~350 MB in RAM and inference uses both cores anyway.
CMD ["uvicorn", "--factory", "app.main:app_factory", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--timeout-keep-alive", "5", "--no-server-header"]
