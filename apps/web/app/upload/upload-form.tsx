'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LocationPicker, type LatLng } from '@/components/maps';
import { Alert, Button, ButtonLink, Field, inputClass } from '@/components/ui';
import { describeError } from '@/lib/api';
import { CATEGORY_LABEL, toLocalInputValue } from '@/lib/format';
import { getCurrentPosition } from '@/lib/geolocation';
import { MAX_PRICE_PAISE, MIN_PRICE_PAISE, formatINR, rupeesToPaise } from '@/lib/money';
import { CATEGORIES, type Category, type MediaOwnerView } from '@/lib/types';
import { uploadMedia, type UploadHandle } from '@/lib/upload';

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_AGE_DAYS = 30;
/** Chennai, used only as the map's starting point until the user shares or picks a location. */
const DEFAULT_CENTER: LatLng = { lat: 13.0827, lng: 80.2707 };

type Phase = { kind: 'editing' } | { kind: 'uploading'; progress: number } | { kind: 'done'; media: MediaOwnerView };

function checkFile(file: File): string | null {
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  // Some Android browsers report an empty type for HEIC; let the server decide from the bytes.
  if (file.type && !isVideo && !isImage) return 'Choose a photo or a video.';
  if (isVideo && file.size > MAX_VIDEO_BYTES) return 'This video is larger than 500 MB. Trim it on your phone and try again.';
  if (isImage && file.size > MAX_PHOTO_BYTES) return 'This photo is larger than 25 MB.';
  return null;
}

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState('');
  const [position, setPosition] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const handle = useRef<UploadHandle | null>(null);

  // A blob: URL lets the browser show the chosen file without uploading it. Revoke it when it
  // changes, or the file stays in memory until the tab closes.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Cancel an in-progress upload if the user leaves the page.
  useEffect(() => () => handle.current?.abort(), []);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError(null);
    if (!f) return;
    const problem = checkFile(f);
    setFileError(problem);
    if (problem) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    // A file's lastModified is usually when it was recorded (for files straight from the camera).
    setCapturedAt(toLocalInputValue(new Date(f.lastModified)));
  }

  async function useMyLocation() {
    setLocating(true);
    setLocationError(null);
    try {
      const p = await getCurrentPosition();
      setPosition({ lat: p.lat, lng: p.lng });
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : String(err));
      setPosition((cur) => cur ?? DEFAULT_CENTER);
    } finally {
      setLocating(false);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    if (!file) return setError('Choose a photo or video first.');
    if (!position) return setError('Add the location: tap “Use my location” or choose it on the map.');

    const captured = new Date(capturedAt);
    if (Number.isNaN(captured.getTime())) return setError('Enter when it was recorded.');
    if (captured.getTime() > Date.now() + 5 * 60_000) return setError('The recording time cannot be in the future.');
    if (captured.getTime() < Date.now() - MAX_AGE_DAYS * 86_400_000)
      return setError(`We only accept footage from the last ${MAX_AGE_DAYS} days.`);

    const prices: { priceNonExclusive?: number; priceExclusive?: number } = {};
    for (const key of ['priceNonExclusive', 'priceExclusive'] as const) {
      const raw = String(f.get(key) ?? '').trim();
      if (!raw) continue;
      const paise = rupeesToPaise(raw);
      if (paise === null || paise < MIN_PRICE_PAISE || paise > MAX_PRICE_PAISE)
        return setError(`Prices must be between ${formatINR(MIN_PRICE_PAISE)} and ${formatINR(MAX_PRICE_PAISE)}.`);
      prices[key] = paise;
    }
    if (prices.priceExclusive !== undefined && prices.priceNonExclusive !== undefined && prices.priceExclusive < prices.priceNonExclusive)
      return setError('The exclusive price must be at least the non-exclusive price.');

    const description = String(f.get('description') ?? '').trim();
    const locationName = String(f.get('locationName') ?? '').trim();

    setPhase({ kind: 'uploading', progress: 0 });
    handle.current = uploadMedia(
      file,
      {
        title: String(f.get('title')).trim(),
        category: String(f.get('category')) as Category,
        latitude: Number(position.lat.toFixed(6)),
        longitude: Number(position.lng.toFixed(6)),
        capturedAt: captured.toISOString(),
        ...(description ? { description } : {}),
        ...(locationName ? { locationName } : {}),
        ...prices,
      },
      (progress) => setPhase({ kind: 'uploading', progress }),
    );
    handle.current.promise.then(
      (media) => setPhase({ kind: 'done', media }),
      (err: unknown) => {
        setError(describeError(err));
        setPhase({ kind: 'editing' });
      },
    );
  }

  if (phase.kind === 'done') {
    return (
      <div className="mt-8 flex flex-col gap-4 rounded-xl border border-verified/40 bg-verified-soft p-6" role="status">
        <h2 className="font-display text-3xl font-bold text-verified">Uploaded. Thank you.</h2>
        <p>
          We are now preparing “{phase.media.title}” and running our checks. A reviewer will look at it next. You can follow
          its status on your dashboard.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/dashboard">See my footage</ButtonLink>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Upload another
          </Button>
        </div>
      </div>
    );
  }

  const uploading = phase.kind === 'uploading';
  const isVideo = file?.type.startsWith('video/') ?? false;

  return (
    <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-6" aria-busy={uploading}>
      <fieldset disabled={uploading} className="flex flex-col gap-6">
        {/* ---- File ---- */}
        <div className="flex flex-col gap-3">
          <label
            htmlFor="file"
            className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line bg-surface p-6 text-center has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus"
          >
            <span className="font-display text-2xl font-bold">{file ? 'Choose a different file' : 'Choose a photo or video'}</span>
            <span className="text-sm text-muted">Videos up to 500 MB · photos up to 25 MB</span>
            <input
              id="file"
              name="file"
              type="file"
              accept="video/*,image/*"
              onChange={onFile}
              className="sr-only"
              aria-describedby={fileError ? 'file-error' : undefined}
            />
          </label>
          {fileError ? (
            <p id="file-error" className="text-sm font-semibold text-danger">
              {fileError}
            </p>
          ) : null}
          {file && previewUrl ? (
            <div className="overflow-hidden rounded-xl bg-black">
              {isVideo ? (
                <video src={previewUrl} controls playsInline muted className="max-h-80 w-full" aria-label="Your selected video" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, nothing to optimise
                <img src={previewUrl} alt="Your selected photo" className="max-h-80 w-full object-contain" />
              )}
              <p className="bg-surface px-3 py-2 text-sm text-muted">
                {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            </div>
          ) : null}
        </div>

        {/* ---- What happened ---- */}
        <Field label="What happened?" htmlFor="title" hint="A short headline, for example “Bus overturned near Tambaram bridge”.">
          <input id="title" name="title" required minLength={5} maxLength={120} aria-describedby="title-hint" className={inputClass} />
        </Field>
        <Field label="Type of incident" htmlFor="category">
          <select id="category" name="category" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose one
            </option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="More details (optional)" htmlFor="description" hint="What you saw, before and after. Do not name people who are hurt.">
          <textarea id="description" name="description" rows={4} maxLength={2000} aria-describedby="description-hint" className={inputClass} />
        </Field>

        {/* ---- Where ---- */}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 font-semibold">Where did it happen?</legend>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={useMyLocation} busy={locating}>
              Use my location
            </Button>
            {!position ? (
              <Button variant="ghost" onClick={() => setPosition(DEFAULT_CENTER)}>
                Choose on the map
              </Button>
            ) : (
              <span className="tabular text-sm text-muted">
                {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
              </span>
            )}
          </div>
          {locationError ? <Alert tone="caution">{locationError}</Alert> : null}
          {position ? (
            <>
              <LocationPicker value={position} onChange={setPosition} />
              <p className="text-sm text-muted">If you are no longer at the spot, drag the pin or tap the map where it happened.</p>
            </>
          ) : null}
          <Field label="Place name (optional)" htmlFor="locationName" hint="Area, road or landmark, e.g. “Anna Salai, near Gemini flyover”.">
            <input id="locationName" name="locationName" maxLength={200} aria-describedby="locationName-hint" className={inputClass} />
          </Field>
        </fieldset>

        {/* ---- When ---- */}
        <Field label="When was it recorded?" htmlFor="capturedAt" hint="Filled in from the file. Correct it if needed.">
          <input
            id="capturedAt"
            name="capturedAt"
            type="datetime-local"
            required
            value={capturedAt}
            onChange={(e) => setCapturedAt(e.target.value)}
            aria-describedby="capturedAt-hint"
            className={inputClass}
          />
        </Field>

        {/* ---- Price ---- */}
        <details className="rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-3 font-semibold">Set your own price (optional)</summary>
          <div className="flex flex-col gap-4 px-4 pb-4">
            <p className="text-sm text-muted">
              Leave empty to use our suggested prices ({isVideo ? '₹1,500 and ₹5,000 for videos' : '₹500 and ₹2,000 for photos'}).
              Prices can be from {formatINR(MIN_PRICE_PAISE)} to {formatINR(MAX_PRICE_PAISE)}.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Non-exclusive price (₹)" htmlFor="priceNonExclusive" hint="Many newsrooms can buy this.">
                <input id="priceNonExclusive" name="priceNonExclusive" inputMode="decimal" aria-describedby="priceNonExclusive-hint" className={inputClass} />
              </Field>
              <Field label="Exclusive price (₹)" htmlFor="priceExclusive" hint="One newsroom only, before anyone else buys.">
                <input id="priceExclusive" name="priceExclusive" inputMode="decimal" aria-describedby="priceExclusive-hint" className={inputClass} />
              </Field>
            </div>
          </div>
        </details>

        {/* ---- Rights ---- */}
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <label className="flex gap-3">
            <input type="checkbox" name="rightsConfirmed" required className="mt-1.5 h-5 w-5 shrink-0" />
            <span>
              <strong>I recorded this myself, it is real and not edited to mislead, and I agree to the uploader licence.</strong>
            </span>
          </label>
          <ul className="list-disc space-y-1 pl-12 text-sm text-muted">
            <li>You keep the copyright. Micky may store it and show newsrooms a watermarked preview.</li>
            <li>When a newsroom buys a licence, it may broadcast and publish the footage. You earn your share of each sale.</li>
            <li>An exclusive licence means only that newsroom can buy it after that.</li>
            <li>
              Do not upload sexual content, footage of children that identifies them, or close-ups of injured people.{' '}
              <Link href="/terms" className="underline" target="_blank">
                Read the full terms
              </Link>
              .
            </li>
          </ul>
        </div>
      </fieldset>

      {error ? <Alert>{error}</Alert> : null}

      {uploading ? (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-sm font-semibold">
            <span>{phase.progress < 1 ? 'Uploading… keep this page open' : 'Finishing up…'}</span>
            <span className="tabular">{Math.round(phase.progress * 100)}%</span>
          </div>
          <progress value={phase.progress} max={1} className="h-3 w-full overflow-hidden rounded-full accent-signal" aria-label="Upload progress" />
          <Button variant="ghost" onClick={() => handle.current?.abort()}>
            Cancel upload
          </Button>
        </div>
      ) : (
        <Button type="submit" size="lg" variant="signal" disabled={!file}>
          Upload footage
        </Button>
      )}
    </form>
  );
}
