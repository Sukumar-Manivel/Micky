# Uploads, media processing and incidents

This note covers the uploader's side of FirstFrame: how a phone video becomes a watermarked preview, a set of verification signals for the admin, and part of an "incident" that news channels can find.

## 1. What was built and why

| Part | Folder / file | What it does |
|---|---|---|
| **MediaModule** | `apps/api/src/media/` | `POST /media` (upload), `GET /me/media`, `GET/PATCH/DELETE /me/media/:id`. Validates the upload, rejects exact duplicates, stores the original, inserts a `PROCESSING` row and **enqueues** a job |
| **ProcessingModule** (producer) | `src/processing/processing.module.ts`, `media-queue.service.ts` | Registers the BullMQ queue `media-processing`. `MediaQueue.enqueue(mediaId)` is all the API ever does with processing |
| **Worker process** | `src/worker.ts`, `src/worker.module.ts` | A second Node process (no HTTP) that consumes the queue |
| **MediaProcessor** (consumer) | `src/processing/media.processor.ts` | BullMQ worker: decides retry vs. give up, marks `FAILED` |
| **MediaProcessingService** | `src/processing/media-processing.service.ts` | The pipeline: probe → previews → verify → incident → `IN_REVIEW` |
| **FFmpeg wrappers** | `src/processing/ffmpeg.ts` | ffprobe, watermark PNG, encrypted HLS, watermarked JPEG, frame sampling |
| **Metadata helpers** | `src/processing/media-metadata.ts` | Pure functions: upright size, preview sizes, GPS/time/device from ffprobe tags and EXIF |
| **Verifier client** | `src/processing/verifier.client.ts` | Calls the Python verifier; classifies failures as retryable or not |
| **Risk + pHash** | `src/processing/risk.ts`, `phash.ts` | Turns evidence into signals and a LOW/MEDIUM/HIGH level; compares perceptual hashes |
| **IncidentsService** | `src/incidents/` | Clusters uploads into incidents (geohash + time window) and keeps trend scores fresh |

**Why:** the platform's promise to news channels is "real footage from the scene, checked before you see it". So every upload must be:
- **safe to show** before purchase: a low-resolution, watermarked, encrypted preview, never the original;
- **checked**: AI-likelihood, provenance (C2PA), duplicates and metadata, summarised for a human reviewer;
- **grouped**: five clips of the same fire are one story (incident), ranked by a trend score.

None of this can happen inside the upload request: encoding a video takes seconds to minutes. So the request only stores the file and hands the work to a background worker.

## 2. How a request flows (file by file)

### Upload: `POST /api/v1/media` (multipart/form-data)

1. **Guards** (`app.module.ts`): rate limit → JWT → `@Roles('UPLOADER')` on `media.controller.ts`. They run **before** the body is read, so a channel or an anonymous user never writes a byte to disk.
2. **`FileInterceptor('file')`** (multer, configured in `media.module.ts`):
   - streams the file to `UPLOAD_TMP_DIR` under a random name (`upload-files.ts: tempDiskStorage`), never into RAM;
   - enforces `fileSize = max(video limit, photo limit)` → **413** if exceeded (multer deletes its partial file itself);
   - limits the number of files, fields and field sizes.
3. **`DeleteTempUploadInterceptor`**: wraps everything after multer. Its `finalize()` deletes the temp file when the request ends, **whatever happened**. This works because Nest runs pipes *inside* `next.handle()`, so even a validation error passes through it.
4. **`ValidationPipe` + `UploadMediaDto`** (`media.dto.ts`): multipart fields are strings, so `@Transform` converts `"9.93"` to a number (and `""` to `undefined`, because `Number("") === 0` would silently put you on the equator). Then `class-validator` checks lengths, ranges, the category enum, ISO date format and `rightsConfirmed === 'true'`. Unknown fields → 400 (`forbidNonWhitelisted`).
5. **`MediaService.upload`** (`media.service.ts`):
   1. **Magic bytes** (`file-type.ts: detectFileType`) on the first 32 bytes → **415** if it is not mp4/mov/webm/jpeg/png/webp/heic. The file name and the browser's Content-Type are ignored.
   2. **Per-type size**: photos ≤ 25 MB → **413**.
   3. **Business rules**: `capturedAt` not more than 5 minutes in the future and not older than 30 days; default prices by type; exclusive ≥ non-exclusive.
   4. **SHA-256** of the file, streamed (`sha256File`). If a non-FAILED media has the same checksum → **409** "This file has already been uploaded".
   5. **Store the original** at `originals/<id>/source.mp4` (`storageKeys.original`). The id is a UUID generated in Node, so the key is known before the row exists.
   6. **Transaction**: `pg_advisory_xact_lock(hashtext(checksum))`, re-check the checksum, `INSERT` the row with `status = 'PROCESSING'` and a geohash (precision 6). If this fails, the stored original is deleted.
   7. **Enqueue** `process-media` with `jobId = mediaId`. If Redis is down, the row and the file are removed and the client gets **503**, so nothing is left stuck in PROCESSING.
   8. Return **201** `MediaOwnerView` (`common/views.ts: toMediaOwnerView`).

### Processing: the worker picks up the job

`src/worker.ts` creates a Nest **application context** (no HTTP server) from `WorkerModule`: config, database, storage, Redis, `IncidentsModule` and the processor. On start it also schedules the trend job and re-queues uploads stuck in PROCESSING (`processing.scheduler.ts`).

`media.processor.ts: process(job)` computes `finalAttempt = attemptsMade + 1 >= attempts` and calls `MediaProcessingService.process(mediaId, { finalAttempt })`:

1. **Load the row.** If it is not PROCESSING any more (already done, or the uploader deleted it), return `'skipped'`.
2. **Download the original** into a private temp dir (`mkdtemp`), deleted in `finally`.
3. **Probe**:
   - Video: `ffprobe` JSON → `media-metadata.ts: readVideoProbe`: duration, codec, **upright** size (a phone writes 1920×1080 plus "rotate −90°"), and capture metadata from container tags (`creation_time`, ISO 6709 location `+09.93+076.26/`, device make/model, encoder). No video track, unreadable file or longer than 10 minutes → `PermanentProcessingError`.
   - Photo: `ffprobe` for the size, `firstFrameRotation` for the EXIF rotation FFmpeg will apply, and `exifr` for capture time, GPS, device and software.
4. **Previews** (skipped if the row already has them from an earlier attempt):
   - Video: a 16-byte random AES key, `encodeHlsPreview` at ≤ 854×480 for at most 30 s, upload of `index.m3u8` + `seg_*.ts` to `previews/<id>/hls/`. The key goes to `media.hls_key_hex`, **not** to storage.
   - Photo: watermarked JPEG (long side ≤ 1280) at `previews/<id>/preview.jpg`.
   - Both: a watermarked thumbnail (long side ≤ 480) at `previews/<id>/thumb.jpg`.
   - Then one `UPDATE` sets `previewKey`, `thumbKey`, `hlsKeyHex`, size and duration. These are exactly the keys `stream.service.ts` reads.
5. **Verify** (skipped if a verifications row exists):
   - Up to 8 frames, spread over the clip (`sampleVideoFrames`), or the photo itself scaled to 1024 px.
   - `VerifierClient.analyze` → `POST {VERIFIER_URL}/v1/analyze` with `X-Internal-Token`, the frames, and the original if ≤ 50 MB (for C2PA).
   - **Verifier down?** Network error or 5xx on a non-final attempt → throw, and BullMQ retries later. On the final attempt, or on a 4xx, continue with `verifierAvailable = false`; the reason is stored in `metadata.verifier.error` and `assessRisk` adds a `VERIFIER_UNAVAILABLE` warning.
   - **Duplicate search** (`findDuplicate`): compare the frame pHashes with those of every **earlier** upload, in batches of 1000; ≤ 8 differing bits on any pair of frames = duplicate. Black/flat frames are ignored (`isInformativePhash`).
   - `assessRisk` (pure function) → signals + risk level. **Upsert** the `verifications` row (`ON CONFLICT (media_id) DO UPDATE`).
6. **Incident**: `IncidentsService.assignIncident(mediaId)` joins a nearby incident (same or neighbouring geohash cell, within 2 h) or creates one. It is idempotent: if `incidentId` is set, it returns it.
7. **Publish**: `UPDATE media SET status = 'IN_REVIEW' WHERE id = $1 AND status = 'PROCESSING'`. This is the **commit point**: until it runs, the job can be retried safely. Because it is conditional, a media removed meanwhile stays REMOVED.

The admin then sees it in `GET /admin/review-queue` (status IN_REVIEW, with full metadata). Approval (`admin.service.ts`) recomputes the incident and emits `media.approved` over Socket.IO.

**Failures** (`media.processor.ts`):
- `PermanentProcessingError` (corrupt file, no video track, too long): `markFailed(id, message)` and throw BullMQ's `UnrecoverableError`, so there is **no retry**. The uploader sees `processingError` in the dashboard.
- Anything else: rethrow so BullMQ retries (4 attempts, exponential backoff 15 s → 30 s → 60 s). On the last attempt, mark FAILED with a generic message.
- `@OnWorkerEvent('failed')` is a safety net for jobs that never reach the catch block (a job that stalled because the worker crashed twice).

### `GET /me/media`, `GET/PATCH/DELETE /me/media/:id`

- Every query filters by `uploaderId = currentUser.id`. Someone else's media gives **404**, not 403, so ids cannot be probed.
- `toViews` loads verifications and sales (`count` and `sum(uploader_share)` of PAID orders) for the whole page in **2 queries** (`IN (...)`), not 2 per item.
- **PATCH** runs in a transaction with `SELECT ... FOR UPDATE` on the media row. Marking an order PAID locks the same row, so "not sold yet" is still true when the new price is written. Price changes after a sale → **409**; unchanged prices sent along with a new title are fine (the web form always sends all fields).
- **DELETE** sets `REMOVED` (soft delete) unless there is a PAID order (**409**: the buyer's licence must keep working). Deleting twice is a 204. If the media belonged to an incident, the incident is recomputed.

## 3. Why a queue and a separate worker

- **The request must be fast.** A 500 MB upload already takes long to transfer; adding a minute of FFmpeg would hit proxy timeouts and tie up the connection. The API stores the file, answers 201 with `status: 'PROCESSING'`, and the dashboard shows progress.
- **CPU isolation.** FFmpeg can use every core. If it ran in the API process, every other request (browsing, payments) would slow down during an encode. In a separate process, the operating system schedules them independently, and you can give the worker its own machine.
- **Reliability.** A job in Redis survives an API restart. If the worker crashes mid-job, BullMQ notices the expired lock ("stalled job") and hands the job to a worker again.
- **Retries and backoff for free.** BullMQ records attempts, waits longer between them, and keeps failed jobs for inspection.
- **Scaling.** More uploads? Start more worker processes (or raise `WORKER_CONCURRENCY`). Redis hands each job to exactly one worker.
- **How the split is enforced:** the queue (producer) is registered in `ProcessingModule`, which both processes import. The `@Processor` class is only in `WorkerModule`'s providers, so the API process has no consumer. The processor uses `autorun: false`, so tests can build the worker module and call the service directly, without a background consumer competing with them.

**BullMQ in one paragraph:** a queue is a set of Redis keys. `queue.add` pushes a job (JSON data + options) into a "wait" list. A worker atomically moves it to "active" and holds a **lock** it keeps renewing. On success the job moves to "completed"; on error to "delayed" (retry later) or "failed". If the lock expires (the worker died), the job is "stalled" and is moved back to wait. Job **ids** deduplicate: adding a job whose id exists does nothing.

## 4. FFmpeg and HLS, simply

**FFmpeg** is a command-line toolbox that decodes almost any video/image format, runs **filters** on the frames, and encodes the result. We start it with `spawn('ffmpeg', [args...])`, an argument array and never a shell string, so a title like `"; rm -rf /` can never become a command.

The preview filter graph (`ffmpeg.ts: watermarkGraph`):
```
[0:v] scale=852:480, setsar=1 [base];    ← input 0 = the video, scaled down
[base][1:v] overlay=0:0, format=yuv420p  ← input 1 = a transparent PNG watermark of the same size
```
- **The watermark PNG** (`makeWatermark`): "FIRSTFRAME PREVIEW" written many times on a transparent square, rotated 30° and cropped to the frame size. It is burned into the pixels, so it cannot be removed by hiding an HTML element.
- **Rotation:** phones record landscape sensor data plus a "rotate 90°" flag. FFmpeg applies the flag automatically while decoding ("autorotate"), also for JPEG EXIF orientation. So we only use the rotation to compute the **upright** width and height; rotating again would turn the picture sideways.
- **Encoding:** H.264 (`libx264 -preset veryfast -crf 28`) and AAC audio, the codecs every browser can play. `-map_metadata -1` removes the original's GPS and device tags from the preview.
- **Sizes are even numbers** because H.264 with 4:2:0 colour stores colour at half resolution: an odd width cannot be halved.

**HLS (HTTP Live Streaming):**
- The video is cut into ~4-second files: `seg_000.ts`, `seg_001.ts`, ... (MPEG-TS format).
- A text **playlist** `index.m3u8` lists them in order.
- The player downloads the playlist, then the segments one by one over plain HTTP. That makes it start fast, seek cheaply and work through caches and CDNs.
- `-force_key_frames` puts a keyframe every 4 s, so each segment starts with a full picture and can play on its own.
- **AES-128:** FFmpeg encrypts every segment with our random 16-byte key. The playlist line `#EXT-X-KEY:METHOD=AES-128,URI="key.bin"` tells the player to fetch the key from the (token-protected) stream route. The key lives in the database, so copying the storage folder alone gives you useless bytes.
- **It is not DRM:** the browser gets the key in the clear while the token is valid. The goal is to make the preview not worth stealing (480p, 30 s, watermark), not to make copying impossible.

## 5. Checksums vs perceptual hashes

| | SHA-256 checksum | Perceptual hash (pHash) |
|---|---|---|
| Question it answers | "Is this the **same file**, byte for byte?" | "Does this **look like** the same picture?" |
| Change one byte | Completely different hash | Same or nearly the same hash |
| Re-encode, resize, re-compress (WhatsApp) | Different | Within a few bits |
| How it is compared | Equality (indexable, `media_checksum_idx`) | **Hamming distance**: number of differing bits out of 64 |
| Where | `POST /media`, before anything is stored → 409 | Worker, after the verifier returns hashes → `DUPLICATE` danger signal |
| Decision | Automatic reject | Advice for the human reviewer |

**How pHash works:** shrink the frame to 32×32 grey pixels, run a 2-D **DCT** (the transform JPEG uses) and keep the 8×8 lowest frequencies, i.e. the coarse shape of the image. Each of the 64 values becomes one bit: above the median → 1. Re-compression and resizing change fine detail (high frequencies), not the coarse shape, so the bits barely move.

**Why compare every pair of frames:** if someone trims the first 5 seconds of a clip, their frame 1 matches the original's frame 3. Taking the minimum distance over all pairs catches that.

**Why ignore near-empty hashes:** every black frame has the hash `0000000000000000`, so two unrelated night clips that start black would "match". Hashes with fewer than 4 or more than 60 bits set are skipped.

**Why the checksum check excludes FAILED uploads:** if processing failed (for example a transient bug on our side), the uploader must be able to try the same file again; the web app tells them to.

**Race between two identical uploads:** both could pass the "is the checksum taken?" check at the same moment. The schema has no unique index on `checksum` (FAILED rows may repeat), so the insert runs under `pg_advisory_xact_lock(hashtext(checksum))`: the second request waits for the first to commit, re-checks and gets 409. The e2e test fires two identical uploads in parallel and expects exactly one 201 and one 409.

## 6. Retries and idempotency

**Idempotent** = running it twice has the same effect as running it once. BullMQ guarantees *at-least-once* processing (a job can run again after a crash or a retry), so every step must be idempotent:

| Step | How it is idempotent |
|---|---|
| Enqueue | `jobId = mediaId`: BullMQ ignores a second job with the same id |
| Start of job | Only media in `PROCESSING` is processed; anything else returns `'skipped'` |
| Previews | Skipped if `previewKey`/`thumbKey`/`hlsKeyHex` are already set. They are written in one UPDATE **after** all files are uploaded, so "set" means "complete". Leftover segments from a half-finished attempt are deleted before uploading again |
| Verification | Skipped if the row exists; written as an **upsert** on the primary key `media_id` |
| Incident | `assignIncident` returns the existing `incidentId`, and runs under an advisory lock so two workers cannot create two incidents for one fire |
| Publish | `UPDATE ... WHERE status = 'PROCESSING'`: matches zero rows the second time |
| Mark failed | Same conditional update |

**Retryable vs permanent errors:**
- Permanent (the file is broken, too long): retrying wastes CPU and delays the bad news → `UnrecoverableError`, FAILED immediately.
- Transient (verifier restarting, storage hiccup): **exponential backoff** (15 s, 30 s, 60 s) gives the dependency time to recover without hammering it.
- **Graceful degradation:** the verifier is helpful but not essential. After the last retry the upload continues without it, and the missing check is visible to the admin as a warning. An upload is never stuck forever because a side service is down.

**Stuck jobs:** if Redis lost data, or the API crashed between the insert and the enqueue, a row could stay PROCESSING with no job. On start, the worker re-enqueues PROCESSING rows older than 2 minutes. Thanks to `jobId = mediaId` this never creates duplicates.

## 7. Trade-offs, and how to scale

| Today | Why | At scale |
|---|---|---|
| Multer writes to the API's disk, then the file is copied to storage | Simple; works with local storage on one VM | **Direct-to-storage uploads**: the API returns a presigned S3/R2 URL (multipart, resumable), the browser uploads straight to storage, the API only gets a "done" callback. The API never touches the bytes |
| Duplicate search scans every earlier pHash in batches | Correct and easy to explain; fine for tens of thousands of uploads | Index the hashes: split each 64-bit hash into 4 × 16-bit bands and index the bands (two hashes ≤ 3 bits apart must share a band), or a **BK-tree** / vector index. Or `bit_count(a # b)` in SQL to avoid moving data |
| Previews encoded once at 480p | One rendition is enough for judging footage | Several renditions (240p/480p) with an HLS master playlist for adaptive bitrate on weak networks |
| One queue for processing and the trend job | One consumer to run | Separate queues per job type, so a long encode never delays trend updates; a GPU or bigger box for the verifier |
| Worker emits no realtime events | The Socket.IO server lives in the API process | Publish events through Redis (Socket.IO Redis adapter/emitter) so the worker's `incident.updated` reaches browsers |
| `capturedAt` is the uploader's claim | Many files have no metadata at all | Already cross-checked against file metadata (signals); could also require it for HIGH-value listings |
| HEIC needs FFmpeg 7+ | Ubuntu's FFmpeg 6.1 cannot decode HEIC | Upgrade FFmpeg, or convert HEIC with libheif before processing. Today such uploads end FAILED with a clear message |
| One AES key and a constant IV for the whole preview | FFmpeg's simple key-info mode | Per-segment IVs (or key rotation with `-hls_flags periodic_rekey`). It barely matters here because previews are deterrence, not DRM |
| Soft delete keeps the files | Reports and audits may need evidence | A retention job that purges originals of REMOVED/REJECTED media after N days |

## 8. Interview questions with model answers

1. **Walk me through what happens when a user uploads a video.**
   Guards check the JWT and the UPLOADER role before any bytes are read. Multer streams the file to a temp directory with a size limit. The DTO validates the text fields. The service sniffs the magic bytes (415 if not a supported format), applies the per-type size limit, checks the capture date and prices, computes a SHA-256 and rejects exact duplicates with 409. It copies the original to storage, inserts the media row as PROCESSING in a transaction, and enqueues a BullMQ job with the media id as job id. It answers 201 right away. An interceptor deletes the temp file whatever happened. A separate worker process then makes the preview, runs the checks and moves the media to IN_REVIEW.

2. **Why not process the video inside the HTTP request?**
   It can take minutes, which hits proxy timeouts and blocks the user. FFmpeg would also steal CPU from every other API request. A queue gives durability (jobs survive restarts), retries with backoff, and horizontal scaling: just run more workers. The API stays fast and predictable.

3. **How do you know a file is really a video?**
   Not from the extension or the Content-Type: the client controls both. I read the first bytes ("magic bytes"): MP4/MOV/HEIC files have an `ftyp` box with a brand, WebM starts with `1A 45 DF A3`, JPEG with `FF D8 FF`, PNG with `89 50 4E 47`. That rejects HTML or executables renamed to `.mp4`. Magic bytes can still be faked, so the worker fully parses the file with ffprobe; if that fails, the media is marked FAILED and never shown.

4. **What is the difference between a checksum and a perceptual hash? Why both?**
   SHA-256 identifies the exact bytes: any change gives a totally different hash. It is perfect for "this exact file was already uploaded" and can be checked with an index lookup, so we reject with 409 before storing anything. A perceptual hash describes what the image looks like, so re-encoded, resized or trimmed copies stay within a few bits (Hamming distance). It catches someone re-uploading another person's footage after passing it through WhatsApp. It is fuzzy, so it is a signal for the reviewer, not an automatic reject.

5. **How do you stop two identical uploads at the same time from both getting in?**
   A check followed by an insert is a race. Normally a unique index solves it, but we allow re-uploading FAILED files, so checksum can't be unique. I take a transaction-scoped advisory lock keyed by the checksum's hash, then re-check and insert. The second request waits for the lock, sees the first row and gets 409. The test fires both requests in parallel and expects one 201 and one 409.

6. **What does idempotent mean, and how did you make the job idempotent?**
   Running it twice has the same effect as once. Queues deliver at least once, so a job may rerun after a crash. Each step checks or is safe to repeat: the job id is the media id, the job only processes PROCESSING media, previews and verification are skipped if already recorded, the verification is an upsert, incident assignment returns the existing incident, and the final status change is conditional on still being PROCESSING.

7. **How do retries work, and which errors do you not retry?**
   BullMQ retries a failed job up to 4 times with exponential backoff (15, 30, 60 s), which gives a restarting dependency time to recover. Errors caused by the file itself (corrupt, no video track, too long) are thrown as `UnrecoverableError`, so the job fails at once and the media becomes FAILED with a message for the uploader. On the last attempt of a transient error we also mark it FAILED, so nothing stays PROCESSING forever.

8. **The AI verifier is down. What happens to uploads?**
   Network errors and 5xx answers make the job retry with backoff (the preview, already saved, is not redone). On the final attempt we stop waiting: we save the verification with `aiScore = null`, record the error in the metadata, and the risk function adds a "verification unavailable, review manually" warning. The upload reaches the admin queue anyway. A 4xx (e.g. wrong internal token) is not retried, because asking again gives the same answer.

9. **What is HLS and why use it for previews?**
   HLS splits a video into short segments listed in an `.m3u8` playlist; the player fetches them over plain HTTP. It starts fast, seeks cheaply, works with CDNs and is supported by hls.js and Safari. It also supports AES-128 encryption with a key URL, which we protect with a short-lived signed token and keep in the database, so stolen segment files are useless on their own.

10. **How is the watermark applied, and why on the server?**
    The worker draws "FIRSTFRAME PREVIEW" tiled diagonally on a transparent PNG and FFmpeg overlays it on every frame before encoding. Because it is in the pixels, a channel can't remove it with dev tools. The player additionally overlays a moving label with the viewer's organisation and time, so a leaked screen recording points back to its source.

11. **How do you handle phone videos recorded in portrait?**
    Phones store landscape sensor data plus a rotation flag (display matrix). ffprobe reports the stored size and the rotation; I swap width and height for ±90° to get the upright size, and FFmpeg applies the rotation itself when decoding. A test uploads a portrait clip and checks the stored size is 240×426, not 426×240.

12. **How do you group uploads into incidents?**
    A geohash turns a coordinate into a string where nearby points share a prefix; at precision 6 a cell is about 1.2 × 0.6 km. A new upload joins an incident in its own cell or one of the 8 neighbours (points near a cell edge) whose time span is within 2 hours, preferring the same category; otherwise a new incident is created. The assignment runs under an advisory lock, so two workers processing two clips of the same fire can't create two incidents.

13. **How is the trend score kept fresh if nothing happens?**
    The score decays with age (Hacker News gravity formula), so it changes even without new uploads. The worker registers a BullMQ **job scheduler** that runs every 5 minutes and recomputes incidents active in the last 72 hours. `upsertJobScheduler` is idempotent, so restarting or running several workers still leaves one schedule.

14. **Why return 404 instead of 403 for another uploader's media?**
    A 403 confirms the id exists. 404 reveals nothing, so ids can't be probed. Every query filters by `uploader_id = currentUser`, which makes the check impossible to forget for one route.

15. **How do you prevent a price change from racing a purchase?**
    The PATCH runs in a transaction that locks the media row with `SELECT ... FOR UPDATE` and checks for PAID orders. Marking an order PAID locks the same row, so the two operations are serialised: either the sale happens first and the price change gets 409, or the price changes first and the sale sees the new state.

16. **What would you change to handle 10× the uploads?**
    Upload directly to object storage with presigned multipart URLs so the API never handles bytes; run more workers on separate machines (the queue already distributes jobs); split queues by job type; put the verifier on a GPU; index perceptual hashes (band hashing or a BK-tree) instead of scanning; serve previews through a CDN with signed URLs, keeping the key route on the API.

## 9. Testing

- **Unit tests** (`npm test`), next to the code:
  - `media/file-type.spec.ts`: every accepted signature, and rejections (HTML, PDF, WAV, AVIF, truncated files).
  - `processing/media-metadata.spec.ts`: preview sizes (even, never upscaled, portrait), rotation, ISO 6709 parsing, placeholder dates, iPhone-style ffprobe tags, EXIF with a UTC offset, and validation of the verifier's JSON.
  - `processing/phash.spec.ts`, `risk.spec.ts`, `incidents/trend.spec.ts`.
- **E2E** (`test/media.e2e-spec.ts`, 46 tests). Fixtures are generated with FFmpeg at test time (test pattern videos, a portrait clip, photos, a corrupt MP4, an HTML file named `.mp4`, a 26 MB fake JPEG). The **verifier is a small HTTP server inside the test**, so the test controls AI scores and pHashes and can simulate it being down (503) or rejecting the token (401). Covered:
  - access rules, 17 validation cases (each also checks the temp file was deleted), 415, 413;
  - 201 response shape, stored original, queued job;
  - 409 duplicates, including two parallel uploads, and re-upload after FAILED;
  - list/filter/pagination, 404 for other uploaders, PATCH and DELETE rules with a paid order;
  - full processing of a video and a photo: HLS files and key, thumbnails, verification signals (location mismatch, re-encoded), incident creation, the admin queue, approval, and streaming the preview through the real stream routes;
  - near-duplicate detection, uninformative hashes ignored, verifier-down retry then degrade, 4xx not retried, no resurrection of removed media, clustering of two nearby uploads;
  - finally the **real BullMQ worker** consumes queued jobs: a good photo reaches IN_REVIEW, and a corrupt MP4 becomes FAILED after exactly one attempt.
- **Manual smoke test:** verifier + API + worker as three processes; register, upload a 12 s 720p MP4, IN_REVIEW in about 5 s, approve as admin, then fetch the playlist, key and segments through signed URLs and decode them with FFmpeg (852×480 H.264 + AAC, watermark visible).
