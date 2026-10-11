# Learning notes: the verifier service

`services/verifier` is a small Python (FastAPI) service. The API's background worker sends it the frames of every upload, and it returns three pieces of **evidence**:

1. **AI-likelihood:** how likely each frame is to be AI-generated.
2. **C2PA provenance:** whether the original file carries a valid Content Credentials signature.
3. **Perceptual hashes:** a fingerprint of each frame, used to spot re-uploads of the same footage.

It never decides "real" or "fake". The worker combines this evidence with metadata and the duplicate search into a risk level, and a human admin reviews every upload.

---

## 1. Why a separate Python service?

**Why:** The machine-learning tools live in Python.
- `transformers` and PyTorch run the AI detector.
- `c2pa-python` is the official C2PA binding, maintained by the Content Authenticity Initiative.
- `ImageHash` does the perceptual hashing.

None of these has a mature, CPU-friendly equivalent in Node. ONNX Runtime for Node exists, but it would mean converting the model ourselves and rewriting the preprocessing.

**What we gain:**
- **Isolation.** Running a 350 MB model inside the NestJS API process would make every API restart slow. A crash in an image decoder or in native code (`libc2pa`, torch) would take the whole API down. As its own container, the verifier can crash, restart or be switched off (`AI_MODEL_ENABLED=false`) without touching logins or payments.
- **Separate resources.** Inference uses the CPU heavily. In its own process, it can't block the Node event loop.
- **The right tool for the job.** Each language does what it is good at.

**What it costs:**
- Another container to build, deploy and monitor.
- A network hop with its own failure modes (timeouts, the service being down).
- A contract that must be kept in sync by hand (`docs/API.md`, enforced on this side by `extra="forbid"` pydantic models).
- Another place where a secret (`INTERNAL_TOKEN`) has to be configured.

The worker handles "verifier unavailable" by saving the upload with `ai.available=false` and leaving the decision to the admin.

## 2. How a request flows, file by file

```
worker (Node)  --multipart-->  uvicorn
  app/middleware.py  RequestLogMiddleware      request id, one JSON log line, X-Request-Id header
  app/middleware.py  BodySizeLimitMiddleware   413 if Content-Length or actual bytes > limit
  app/middleware.py  InternalAuthMiddleware    401 unless X-Internal-Token matches (compare_digest)
  app/main.py        analyze()
      request.form(max_files=17, max_fields=8)   parse multipart (big parts spool to temp files)
      validate media_type, 1..16 frames, original size
      app/images.py  decode_frame()              size -> format (JPEG/PNG) -> pixel count -> decode -> RGB
      _wait_for_model()                          bounded wait if the model is still loading
      asyncio.gather(run_in_threadpool(...) x3)  the three checks run in parallel worker threads:
          app/detector.py   score_frames()       ViT -> P(AI) per frame -> median
          app/c2pa_check.py check_c2pa()         read + validate manifest from `original`
          app/phash.py      phash_frames()       16-hex pHash per frame
      form.close()                               deletes the spooled temp files
  app/schemas.py     AnalyzeResponse             pydantic model = the contract
```

At startup, `create_app()` (the **application factory**) does the setup:
- Reads `app/config.py` settings.
- Configures JSON logging and Pillow's bomb limit.
- In `lifespan`, starts loading the model in a background thread, so `/health` answers straight away.

Tests call `create_app(settings, detector=FakeDetector(...))`. This is **dependency injection**: no torch and no network needed.

Why parse the multipart body by hand (`request.form(...)`) instead of FastAPI's `File()` parameters? It lets us cap the number of parts *while parsing*, so a request with 10,000 tiny parts is refused early.

## 3. How the AI classifier works

The model is a **Vision Transformer (ViT-Base/16)**. Someone fine-tuned it on a dataset of real photos versus AI-generated images.

1. **Preprocess.** Resize to 224×224 and normalise pixel values. The model's `preprocessor_config.json` says how; the `transformers` pipeline does it for us.
2. **Patchify.** Cut the image into 14×14 = 196 patches of 16×16 pixels. Each patch becomes a vector, like a "word". A special `[CLS]` token is added at the front.
3. **Transformer.** 12 layers of self-attention let every patch "look at" every other patch. This lets the model notice global inconsistencies, such as lighting, textures that repeat, or skin that is too smooth.
4. **Classification head.** A linear layer turns the final `[CLS]` vector into 2 numbers (**logits**), one per label.
5. **Softmax.** `p_i = exp(z_i) / Σ exp(z_j)` turns the logits into probabilities that sum to 1.

The model's `config.json` has `id2label = {0: "human", 1: "AI-generated"}`. So our score is the probability of the label `"AI-generated"`.

The code looks the label up **by name** and refuses to load if that name is missing. If someone swaps in a model where index 1 means "real", the scores can't silently flip.

**Why score each frame, then take the median?**
- The model only understands still images, so we score sampled frames.
- One odd frame (a black frame at a cut, motion blur, heavy compression) can get an extreme score. The **median** ignores up to half the frames being outliers. The **mean** would be dragged by one bad frame.
- We also return every frame score. The worker can then compute the top-3 mean (from `RESEARCH.md`) to catch a short AI-generated clip spliced into real footage, which the median would hide.

**CPU and concurrency details:**
- The model loads once.
- Inference is CPU-bound, blocking code, so it runs in a threadpool via `run_in_threadpool`. The asyncio event loop keeps answering `/health`.
- A lock lets only one forward pass run at a time. On 2 cores, two at once would just compete for the CPU and double the memory use.
- There is one uvicorn worker, because each worker would load its own copy of the model.

## 4. Why AI detection is unreliable

**The numbers:** detectors like this one report about **98% accuracy on their own test set**. In independent tests on modern generators (OpenFake, 2025; see `docs/RESEARCH.md`), they caught **as little as 9–24%** of AI-generated images.

**Why:**
- **Distribution shift.** The model learned the fingerprints of the generators in its training data. New generators (newer diffusion models, video models) leave different traces.
- **Post-processing destroys traces.** WhatsApp recompression, resizing, screenshots and re-filming a screen all remove the high-frequency artefacts detectors depend on. Our frames are also re-encoded by `ffmpeg`.
- **False positives.** Real photos can look "AI-like": night shots with heavy phone denoising, beauty filters, HDR.
- **Adversarial.** Anyone who wants to fool a public detector can test against it until it passes.

**Consequences in our design:**
- The score is one signal among several and never rejects anything by itself.
- The UI calls it "AI-likelihood", not "fake".
- `available=false` is a normal, handled state.

## 5. C2PA, explained simply

C2PA (Content Credentials) works like a **tamper-evident seal applied by the camera**.

1. When a supporting phone takes a photo, it writes a **manifest** into the file: who made it (the device or app), what happened ("captured", "cropped"), and a **hash of the pixels**.
2. It **signs** the manifest with a private key whose certificate chains up to the manufacturer.
3. Our verifier recomputes the hash and checks the signature.
   - If the pixels changed after signing, the hash doesn't match: status **`invalid`** (our test flips one byte to prove it).
   - If everything matches: status **`valid`**, and we return the certificate's `issuer` (organisation) and the `claim_generator` (the app).

What each status means for us:

| Status | Meaning | Signal |
|---|---|---|
| `valid` | Signed, untouched since signing | Strong positive (once the issuer is trusted) |
| `invalid` | Signed, but modified afterwards, or signature broken | Warning, admin should look |
| `absent` | No manifest | **Neutral.** Most phones (iPhone, most Androids) don't sign, and WhatsApp strips it |
| `error` | Couldn't parse the file | Neutral, logged |
| `unsupported` | No original was sent (>50 MB) or the library is unavailable | Neutral |

**Two subtleties in the code:**
- **Trust ≠ integrity.** We haven't loaded the official C2PA trust list yet, so every signer gets `signingCredential.untrusted`. That code means "we don't know this signer", not "tampered". We ignore it when choosing `valid`/`invalid`, and show the issuer so a human can judge it. Anyone can make a certificate that says "Samsung", so a trust list is the important next step.
- **No network from untrusted files.** A manifest can point to a *remote* manifest URL, and certificates can point to OCSP servers. An uploader could use those to make our server fetch any URL they choose (SSRF). We turn both off: `verify.remote_manifest_fetch=false`, `verify.ocsp_fetch=false`.

API used (c2pa-python 0.38.0, c2pa-rs 0.91):

```python
ctx = c2pa.Context(c2pa.Settings.from_dict({"verify": {...}}))
reader = c2pa.Reader.try_create(mime_or_None, stream, None, ctx)   # None => no manifest
reader.get_validation_state()      # "Valid" | "Invalid" | "Trusted"
reader.get_validation_results()    # {"activeManifest": {"success": [...], "failure": [...]}}
reader.get_active_manifest()       # {"signature_info": {"issuer": ...}, "claim_generator_info": [...]}
```

## 6. Perceptual hash vs cryptographic hash

| | SHA-256 (cryptographic) | pHash (perceptual) |
|---|---|---|
| Goal | Detect *any* change | Ignore changes a human wouldn't notice |
| One pixel changes | Completely different hash (avalanche effect) | Same or nearly the same hash |
| Re-encode or resize | Different | ~0–4 bits differ |
| Compare by | Equality | **Hamming distance** (number of differing bits) |
| Used for | Integrity, dedup of identical files, passwords (with salt and KDF) | Near-duplicate search |

How pHash works:
1. Convert to greyscale and shrink to 32×32.
2. Run a **DCT** (the frequency transform JPEG uses).
3. Keep the 8×8 lowest frequencies, which capture the overall structure.
4. Set each bit to 1 if that coefficient is above the median.

That gives 64 bits, or 16 hex characters. The worker treats a distance of **≤ 8 bits** as a likely copy.

**Limits:** pHash is not robust to heavy cropping, mirroring or rotation. It is also not secure: an attacker can tweak an image to change its hash. It is a helper for duplicate detection, not proof.

## 7. Security of internal service auth

The verifier is protected by **several layers**:

- **Network isolation (main layer).** In Docker Compose, the verifier is only on the internal network and has no published port. Only the worker can reach it.
- **Shared-secret header.**
  - Every `/v1/*` request needs `X-Internal-Token`.
  - The check runs in ASGI middleware *before the body is read*, so unauthenticated clients can't make us buffer 66 MB.
  - It is compared with `secrets.compare_digest`. A normal `==` stops at the first differing byte, so response timing can reveal how much of a guess was right (a **timing attack**). `compare_digest` always takes the same time for strings of the same length.
  - The token is kept in `SecretStr`, so it never appears in logs or reprs.
- **Fail closed.** If `INTERNAL_TOKEN` is empty, *every* request is rejected. A forgotten env var can't leave the service open.
- **Input limits.**
  - The whole body is capped (checked against both Content-Length and the actual bytes streamed).
  - Each frame is capped in bytes.
  - Each frame is capped in **pixels**. Pillow's `MAX_IMAGE_PIXELS` protects against **decompression bombs**: a tiny PNG that decodes to gigabytes.
  - Only JPEG and PNG are accepted, checked by actually decoding the image, not by the extension or `Content-Type`.
- **No information leaks.**
  - Errors are always `{"detail": "..."}`. Stack traces go only to our JSON logs.
  - `/docs` and `/openapi.json` are disabled.
  - The `Server` header is removed.
- **Least privilege in Docker.**
  - Runs as a non-root user (uid 10001).
  - The model is baked into the image at a pinned commit, and the container runs with `HF_HUB_OFFLINE=1`. It needs no outbound internet, and a compromised model repo can't change what we run.

**What a stronger setup would add:** mTLS between services, or short-lived signed tokens (for example, an HMAC over the body and a timestamp, to stop replays), plus regular token rotation. For two containers on one host, a long random token on a private network is a reasonable trade-off.

## 8. Trade-offs we made

- **Median instead of a learned aggregator.** Simple and explainable. We return the raw per-frame scores so the worker can try other aggregations later.
- **Model loads in the background.** Fast startup and a healthy container, but early requests may wait (up to 60 s) or get `ai.available=false`.
- **One worker plus a lock.** Predictable memory (~1.2 GB) on a 12 GB box, at the cost of handling one inference at a time. The worker's job queue absorbs bursts.
- **No trust list yet.** Fewer moving parts now. Until it's added, the issuer must be read by a human.
- **Tests use a fake detector.** Fast, deterministic CI with no network. The real model is checked by a manual smoke test, so a broken model download would not fail CI.

## 9. Interview questions with model answers

**Q1. Why did you put AI detection in a separate Python service instead of the Node API?**
The ML ecosystem (PyTorch, transformers, c2pa-python) is in Python. Isolation also matters: a 350 MB model and native decoders shouldn't be able to crash or slow down the API that handles logins and payments. The cost is one more deployable, a network hop and a hand-maintained contract. I reduced those costs with strict response schemas, a health endpoint, and graceful degradation (`available=false`).

**Q2. Your detector says 98% accuracy. Why don't you auto-reject AI content?**
That 98% is on the model's own test distribution. Independent tests like OpenFake (2025) found detectors catching as little as 9–24% of images from modern generators. Recompression and resizing also erase the artefacts detectors rely on. So both false negatives and false positives are common. We treat the score as one signal among several, and a human makes the final call.

**Q3. Why score multiple frames and take the median?**
Single frames are noisy: cuts, blur, compression. The median is robust to outliers. One crazy frame can't flip the result, while the mean would move. We still return every frame's score, so the worker can use the top-3 mean to catch a short AI-generated insert.

**Q4. How do you know which output label means "AI"?**
I read the model's `config.json`: `id2label = {0: "human", 1: "AI-generated"}`. The code looks the label up by name and refuses to load if it isn't there. If a model swap changed the label order, the service would report the model as unavailable instead of silently inverting the scores.

**Q5. What's softmax and why does it matter here?**
Softmax turns the head's raw scores (logits) into probabilities that are positive and sum to 1: `exp(z_i)/Σexp(z_j)`. With two labels, P(AI) = 1 − P(human). That makes the number easy to read and compare across frames. Note that it is not a *calibrated* probability on our data. A 0.7 doesn't mean "70% of such images are AI".

**Q6. The model inference is synchronous. How do you avoid blocking FastAPI?**
FastAPI runs on an asyncio event loop. A CPU-bound call made directly in an `async def` would freeze every other request, including health checks. I call it via `run_in_threadpool`. PyTorch releases the GIL inside its C++ kernels, so this works well. A lock keeps only one forward pass running on our 2-core box, and the model is loaded once, in the background, at startup.

**Q7. What is C2PA and what does each status mean?**
C2PA is a standard where the capture device or editing app embeds a signed manifest containing a hash of the content and an edit history. `valid` means the signature checks out and the content is unchanged. `invalid` means it was modified after signing, or the signature is broken. `absent` means there is no manifest, which is normal: iPhones don't sign and WhatsApp strips metadata, so absence is neutral, not suspicious. `error` and `unsupported` mean we couldn't check.

**Q8. If a file has a valid C2PA signature, is it definitely real?**
No. It proves the file hasn't changed since *someone* signed it. Without a trust list, anyone can create a certificate claiming to be any company. Even a trusted signature only says "this device or app produced this file". A phone can photograph a screen showing an AI image. That's why we return the issuer for a human to judge, and why adding the official trust list is a planned next step.

**Q9. What's the difference between a perceptual hash and SHA-256? When would you use each?**
SHA-256 changes completely if a single bit changes. It's for integrity and exact dedup. pHash summarises the image's low-frequency structure (via a DCT), so re-encoded or resized copies get nearly the same 64-bit hash. You compare pHashes by Hamming distance (≤ 8 bits = likely copy). I'd use SHA-256 to check that a download wasn't corrupted, and pHash to find the same viral clip uploaded by ten people.

**Q10. How is the internal endpoint secured?**
Defence in depth:
- The service isn't exposed outside the Docker network.
- Every `/v1` request needs a shared token, checked in middleware *before* reading the body and compared with `secrets.compare_digest` to avoid timing attacks.
- An empty token configuration rejects everything (fail closed).
- Body, frame-size and pixel limits stop resource exhaustion.
- Errors never include stack traces.
- The container runs as non-root and offline.

**Q11. What is a timing attack and how does `compare_digest` stop it?**
A normal string comparison returns as soon as it finds a mismatch. By measuring response times over many requests, an attacker can learn the secret one character at a time. `compare_digest` takes the same time no matter where the strings differ, so timing reveals nothing beyond the length.

**Q12. What is a decompression bomb and how do you defend against it?**
It is a tiny compressed image, say a 50 KB PNG, that claims enormous dimensions, so decoding it would need gigabytes of RAM. We check the declared width × height from the header *before* decoding and reject anything over `MAX_IMAGE_PIXELS`. We also set Pillow's global limit and turn its warning into an error.

**Q13. Why could reading C2PA from an uploaded file be an SSRF risk, and what did you do?**
C2PA allows a manifest to be stored at a remote URL, and certificate revocation checks (OCSP) call URLs taken from the certificate. Both are controlled by whoever made the file. Following them would let an uploader make our server send requests to internal addresses. We turn off `remote_manifest_fetch` and `ocsp_fetch` in the reader settings.

**Q14. How did you test this without downloading the model?**
The detector is an interface (a `Protocol`), and the app factory accepts any implementation. Tests inject a `FakeDetector` with known scores and check that, for example, [0.1, 0.9, 0.3, 0.8, 0.2] aggregates to 0.3. For C2PA, the tests generate a throw-away certificate chain and sign a JPEG on the fly. They then check that it reads as `valid` and becomes `invalid` after flipping one byte. CI stays fast and needs no network.

**Q15. What happens if the model fails to load in production?**
`load()` catches the exception and logs it, and the service keeps running. `/health` shows `ai_model_loaded: false`, and every response has `ai.available=false, score=null`. C2PA and pHash still work. The worker records "AI check unavailable", and the admin reviews the upload without that signal. One failing component degrades the result instead of causing an outage.

**Q16. How would you scale this if uploads grew 100×?**
- The service is stateless, so you can run more replicas behind the queue. Each needs ~1.2 GB for the model.
- Then optimise inference: export to ONNX or quantise to int8 for roughly 2–4× faster CPU inference, batch frames across requests, and sample fewer frames for long videos.
- If GPUs are affordable, one GPU replica replaces many CPU ones.
- The queue between the API and the worker already absorbs bursts.
