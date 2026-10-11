'use client';

// The protected preview player.
//
// What it does:
// - Asks the API for a short-lived preview session (POST /market/media/:id/preview), which
//   returns a signed HLS playlist (video) or a signed image URL (photo) plus watermark text.
// - Plays HLS with hls.js. Safari (and iOS) can play HLS natively, so there we just set `src`.
//   The stream is AES-128 encrypted; hls.js fetches the key from the signed URL and decrypts.
// - For a newsroom, the pictures themselves carry its name and account code: the worker burns
//   them into that newsroom's own copy of the preview on its first view (the API answers
//   202 "preparing" meanwhile, and this player asks again). A saved stream or a screen
//   recording therefore names whoever leaked it. The text drawn on top here is extra.
// - Turns off the browser's easy ways to save it (download button, right-click menu,
//   picture-in-picture, casting). This is friction, not DRM: anyone can still record the
//   screen. The real protection is what reaches the browser before payment: at most 40% of
//   the clip (30 s max), at 360p for short clips (480p otherwise), photos at 640 px, all
//   with burned-in marks. After an exclusive sale, other newsrooms get no preview (410).
// - Signed URLs expire after about 10 minutes, so it fetches a new session shortly before
//   `expiresAt` (and on a playback error caused by an expired token) and resumes where it was.

import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { ApiError, describeError, marketApi } from '@/lib/api';
import { createHlsErrorPolicy, unplayableMessage } from '@/lib/hls-errors';
import type { MediaType, PreviewSession } from '@/lib/types';
import { Button, Skeleton } from './ui';

/** Refresh this long before the URLs expire, so playback never hits a dead link. */
const REFRESH_MARGIN_MS = 45_000;
/** How many times to ask again while the newsroom's marked copy is being prepared (202). */
const MAX_PREPARING_POLLS = 40;

/** POST /preview answers 202 with this while the worker renders a newsroom's marked copy. */
type PreparingSession = { kind: 'preparing'; retryAfterSec: number };

/** Who is watching decides the caption: a buyer, the uploader themselves, or a reviewer. */
export type PreviewAudience = 'buyer' | 'owner' | 'admin';

const CAPTION: Record<PreviewAudience, string> = {
  buyer:
    'Preview with your newsroom’s name and account code burned into the picture, at reduced quality. Buy a licence to download the full-quality file without watermarks.',
  owner:
    'This is the watermarked preview. Each newsroom sees its own copy with its name burned in. Newsrooms get the full file only after buying a licence, with your name, GPS and phone details removed from it.',
  admin: 'Watermarked review preview. The original file is never sent to the browser here.',
};

const LENGTH_NOTE: Record<MediaType, string> = {
  VIDEO: ' Video previews show at most 40% of the clip (never more than 30 seconds), at 360p or 480p.',
  PHOTO: ' Photo previews are at most 640 pixels wide.',
};

export function PreviewPlayer({
  mediaId,
  type,
  title,
  audience = 'buyer',
  posterUrl = null,
}: {
  mediaId: string;
  type: MediaType;
  title: string;
  audience?: PreviewAudience;
  /** The watermarked thumbnail: shown before playback starts and behind any error. */
  posterUrl?: string | null;
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** No "Try again" when retrying cannot help (the preview was closed by an exclusive sale). */
  const [final, setFinal] = useState(false);
  const [preparing, setPreparing] = useState(false);
  /** Bumped to ask again while the marked copy is being prepared. */
  const [pollTick, setPollTick] = useState(0);
  const polls = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      const next = (await marketApi.preview(mediaId)) as PreviewSession | PreparingSession;
      if (next.kind === 'preparing') {
        // First view of this footage by this newsroom: its marked copy is being rendered.
        polls.current += 1;
        if (polls.current > MAX_PREPARING_POLLS) {
          setPreparing(false);
          setError('The preview is taking longer than usual to prepare. Please try again in a few minutes.');
          return;
        }
        setPreparing(true);
        pollTimer.current = setTimeout(() => setPollTick((t) => t + 1), Math.max(1, next.retryAfterSec) * 1000);
        return;
      }
      polls.current = 0;
      setPreparing(false);
      setSession(next);
      setError(null);
      setFinal(false);
    } catch (err) {
      setPreparing(false);
      setSession(null);
      setFinal(err instanceof ApiError && err.status === 410);
      setError(describeError(err));
    }
  }, [mediaId]);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  useEffect(() => {
    // Fetching on mount (and again while the marked copy is being prepared) is a legitimate
    // effect: we synchronise with an external system (the API).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, pollTick]);

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
        {error && posterUrl ? (
          // Keep showing what the footage looks like; the message sits in a bar over the picture.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        ) : null}
        {error ? (
          <div
            className={
              posterUrl
                ? 'absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-3 bg-black/75 p-3 text-center text-sm text-white'
                : 'flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white'
            }
          >
            <p className="font-semibold">{error}</p>
            {final ? null : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  polls.current = 0;
                  void load();
                }}
              >
                Try again
              </Button>
            )}
          </div>
        ) : preparing && !session ? (
          <div role="status" className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-white">
            <p className="font-semibold">Preparing your newsroom’s copy of the preview…</p>
            <p className="text-sm text-white/70">Your organisation’s name is being added to the picture. This takes a few seconds.</p>
          </div>
        ) : !session ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : session.kind === 'hls' ? (
          <HlsVideo
            ref={videoRef}
            src={session.playlistUrl}
            title={title}
            posterUrl={posterUrl}
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
          {LENGTH_NOTE[type]}
        </span>
        {audience === 'buyer' ? (
          <span className="text-xs">
            Saving is switched off in this player, but no website can stop a screen recording or a determined copy. That is
            why your organisation’s name and account code are part of the picture itself: a copy shows where it came from.
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
  posterUrl: string | null;
  resumeAt: React.RefObject<number>;
  wasPlaying: React.RefObject<boolean>;
  onExpired: () => void;
  /** Called once the player has given up (see lib/hls-errors.ts), with a message for the viewer. */
  onUnplayable: (message: string) => void;
}

function HlsVideo({ ref, src, title, posterUrl, resumeAt, wasPlaying, onExpired, onUnplayable }: HlsVideoProps) {
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
      poster={posterUrl ?? undefined}
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
