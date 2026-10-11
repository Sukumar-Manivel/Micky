'use client';

// The protected preview player.
//
// What it does:
// - Asks the API for a short-lived preview session (POST /market/media/:id/preview), which
//   returns a signed HLS playlist (video) or a signed image URL (photo) plus watermark text.
// - Plays HLS with hls.js. Safari (and iOS) can play HLS natively, so there we just set `src`.
//   The stream is AES-128 encrypted; hls.js fetches the key from the signed URL and decrypts.
// - Draws the viewer's organisation name over the picture, drifting around the frame, so a
//   screen recording carries the name of whoever leaked it.
// - Turns off the browser's easy ways to save it (download button, right-click menu,
//   picture-in-picture, casting). This is friction, not DRM: see docs/RESEARCH.md
//   "Protecting previews". The real protection is that only a 480p, 30-second, watermarked
//   preview ever reaches the browser before payment.
// - Signed URLs expire after about 10 minutes, so it fetches a new session shortly before
//   `expiresAt` (and on a playback error caused by an expired token) and resumes where it was.

import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { describeError, marketApi } from '@/lib/api';
import { createHlsErrorPolicy, unplayableMessage } from '@/lib/hls-errors';
import type { MediaType, PreviewSession } from '@/lib/types';
import { Button, Skeleton } from './ui';

/** Refresh this long before the URLs expire, so playback never hits a dead link. */
const REFRESH_MARGIN_MS = 45_000;

/** Who is watching decides the caption: a buyer, the uploader themselves, or a reviewer. */
export type PreviewAudience = 'buyer' | 'owner' | 'admin';

const CAPTION: Record<PreviewAudience, string> = {
  buyer: 'Watermarked preview with your newsroom’s name, at reduced quality. Buy a licence to download the clean original.',
  owner: 'This is the watermarked preview newsrooms see. Your original file stays private until a newsroom buys a licence.',
  admin: 'Watermarked review preview. The original file is never sent to the browser here.',
};

export function PreviewPlayer({
  mediaId,
  type,
  title,
  audience = 'buyer',
}: {
  mediaId: string;
  type: MediaType;
  title: string;
  audience?: PreviewAudience;
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resumeAt = useRef(0);
  const wasPlaying = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    // Remember the playhead so a refreshed session continues from the same moment.
    const v = videoRef.current;
    if (v) {
      resumeAt.current = v.currentTime;
      wasPlaying.current = !v.paused;
    }
    try {
      setSession(await marketApi.preview(mediaId));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [mediaId]);

  useEffect(() => {
    // Fetching on mount is a legitimate effect: we synchronise with an external system (the API).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Schedule the next refresh just before this session expires.
  useEffect(() => {
    if (!session) return;
    const ms = new Date(session.expiresAt).getTime() - Date.now() - REFRESH_MARGIN_MS;
    const timer = setTimeout(() => void load(), Math.max(ms, 5_000));
    return () => clearTimeout(timer);
  }, [session, load]);

  return (
    <figure className="flex flex-col gap-2">
      <div
        className="relative aspect-video w-full select-none overflow-hidden rounded-xl bg-black"
        // Block the right-click / long-press menu ("Save video as…", "Save image as…").
        onContextMenu={(e) => e.preventDefault()}
        // Stop dragging the picture out to the desktop or another tab.
        onDragStart={(e) => e.preventDefault()}
      >
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white">
            <p className="font-semibold">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !session ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : session.kind === 'hls' ? (
          <HlsVideo
            ref={videoRef}
            src={session.playlistUrl}
            title={title}
            resumeAt={resumeAt}
            wasPlaying={wasPlaying}
            onExpired={() => void load()}
            onUnplayable={(message) => {
              setSession(null);
              setError(message);
            }}
          />
        ) : (
          // A plain <img>: next/image would proxy and cache the signed, expiring URL, which we don't want.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.imageUrl}
            alt={`Preview of ${title}`}
            draggable={false}
            className="pointer-events-none h-full w-full object-contain"
          />
        )}
        {session && !error ? <WatermarkOverlay text={session.watermarkText} /> : null}
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white">
          Preview
        </span>
      </div>
      <figcaption className="flex flex-col gap-1 text-sm text-muted">
        <span>
          {CAPTION[audience]}
          {type === 'VIDEO' ? ' Video previews are at most 30 seconds.' : ''}
        </span>
        {audience === 'buyer' ? (
          <span className="text-xs">
            Saving is switched off in this player, but no website can stop a screen recording. That is why every preview
            carries your organisation’s name and the date.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Drifting text over the picture. pointer-events: none, so the video controls still work. */
function WatermarkOverlay({ text }: { text: string }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="watermark-drift absolute left-0 top-0 whitespace-nowrap text-sm font-bold text-white/55 [text-shadow:0_1px_2px_rgb(0_0_0/0.6)] sm:text-lg">
        {text}
      </div>
      <div className="absolute bottom-12 right-3 text-[11px] font-semibold text-white/45">{text}</div>
    </div>
  );
}

interface HlsVideoProps {
  ref: React.Ref<HTMLVideoElement>;
  src: string;
  title: string;
  resumeAt: React.RefObject<number>;
  wasPlaying: React.RefObject<boolean>;
  onExpired: () => void;
  /** Called once the player has given up (see lib/hls-errors.ts), with a message for the viewer. */
  onUnplayable: (message: string) => void;
}

function HlsVideo({ ref, src, title, resumeAt, wasPlaying, onExpired, onUnplayable }: HlsVideoProps) {
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const onExpiredRef = useRef(onExpired);
  const onUnplayableRef = useRef(onUnplayable);
  // Lives as long as this player, across session refreshes (new `src`), so retries stay bounded.
  const decide = useRef(createHlsErrorPolicy());
  useEffect(() => {
    onExpiredRef.current = onExpired;
    onUnplayableRef.current = onUnplayable;
  }, [onExpired, onUnplayable]);

  // Merge our ref with the parent's (React 19 passes `ref` as a normal prop).
  const setRefs = useCallback(
    (el: HTMLVideoElement | null) => {
      innerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  useEffect(() => {
    const video = innerRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    let disposed = false;

    const resume = () => {
      if (resumeAt.current > 0) video.currentTime = resumeAt.current;
      if (wasPlaying.current) void video.play().catch(() => undefined);
    };

    (async () => {
      // hls.js is about 150 kB, so it is loaded only when a player actually appears.
      const { default: HlsLib } = await import('hls.js');
      if (disposed) return;
      if (HlsLib.isSupported()) {
        hls = new HlsLib({ enableWorker: true, lowLatencyMode: false });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // Bounded recovery: an unconditional recoverMediaError() looped forever (re-downloading
          // the same segment many times a second) in browsers that cannot decode H.264/AAC.
          switch (decide.current({ type: data.type })) {
            case 'recover-media':
              hls?.recoverMediaError();
              break;
            case 'swap-codec-and-recover':
              hls?.swapAudioCodec();
              hls?.recoverMediaError();
              break;
            case 'refresh-session':
              // Usually the signed token expired (401/404 from the stream routes): get a new session.
              onExpiredRef.current();
              break;
            case 'give-up':
              hls?.destroy();
              hls = null;
              onUnplayableRef.current(unplayableMessage(data.type));
              break;
          }
        });
        hls.on(HlsLib.Events.MANIFEST_PARSED, resume);
        hls.loadSource(src);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari: native HLS (including AES-128 decryption).
        video.src = src;
        video.addEventListener('loadedmetadata', resume, { once: true });
      }
    })();

    return () => {
      disposed = true;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [src, resumeAt, wasPlaying]);

  return (
    <video
      ref={setRefs}
      aria-label={`Preview of ${title}`}
      className="h-full w-full"
      controls
      playsInline
      // Hide "Download", block picture-in-picture and casting; see the note at the top.
      controlsList="nodownload noremoteplayback noplaybackrate"
      disablePictureInPicture
      disableRemotePlayback
      preload="metadata"
    />
  );
}
