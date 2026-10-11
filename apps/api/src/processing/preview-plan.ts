// How much of a clip a newsroom sees before paying, and how it is marked.
//
// Most eyewitness clips are short. A fixed "first 30 seconds" preview gave away the
// whole story for anything under 30 s, at a broadcastable 480p. Now:
//   - length: min(PREVIEW_MAX_SECONDS, 40 % of the clip), at least 1 s;
//   - size: 360p for clips under 30 s (the ones a full-length preview would give away),
//     480p for longer ones;
//   - marks: denser and more opaque for short clips;
//   - photos: at most 640 px on the long side.
export const PREVIEW_FRACTION = 0.4;
/** Used when the container does not say how long the clip is (some WebM files). */
export const UNKNOWN_DURATION_PREVIEW_SEC = 10;
export const SHORT_CLIP_SEC = 30;

export const PHOTO_PREVIEW = { long: 640, short: 640 } as const;
export const THUMBNAIL = { long: 480, short: 480 } as const;

export interface MarkStyle {
  opacity: number;
  fontScale: number;
}

export interface VideoPreviewPlan {
  seconds: number;
  size: { long: number; short: number };
  mark: MarkStyle;
  /** Bitrate cap of the per-newsroom rendition. */
  viewerMaxrateKbps: number;
}

export const NORMAL_MARK: MarkStyle = { opacity: 0.32, fontScale: 1 / 16 };
export const HEAVY_MARK: MarkStyle = { opacity: 0.42, fontScale: 1 / 20 };
/** The newsroom's own mark, tiled in the other direction over the generic one. */
export const VIEWER_MARK: MarkStyle = { opacity: 0.4, fontScale: 1 / 18 };

export function videoPreviewPlan(durationSec: number | null, maxSeconds: number): VideoPreviewPlan {
  const known = durationSec !== null && Number.isFinite(durationSec) && durationSec > 0;
  const seconds = known
    ? Math.max(1, Math.min(maxSeconds, Math.floor(durationSec * PREVIEW_FRACTION * 10) / 10))
    : Math.min(maxSeconds, UNKNOWN_DURATION_PREVIEW_SEC);
  const short = !known || durationSec < SHORT_CLIP_SEC;
  return {
    seconds,
    size: short ? { long: 640, short: 360 } : { long: 854, short: 480 },
    mark: short ? HEAVY_MARK : NORMAL_MARK,
    viewerMaxrateKbps: short ? 800 : 1200,
  };
}

// ---------- Per-newsroom renditions ----------

/** Storage keys of preview files that `storageKeys` (shared, read-only for us) does not cover. */
export const previewKeys = {
  /** Private MP4 every video rendition is made from. Never served. */
  mezzanine: (mediaId: string) => `previews/${mediaId}/mezzanine.mp4`,
  viewerRoot: (mediaId: string) => `previews/${mediaId}/v`,
  viewerDir: (mediaId: string, viewerId: string) => `previews/${mediaId}/v/${viewerId}`,
  viewerPlaylist: (mediaId: string, viewerId: string) => `previews/${mediaId}/v/${viewerId}/index.m3u8`,
  viewerImage: (mediaId: string, viewerId: string) => `previews/${mediaId}/v/${viewerId}/image.jpg`,
};

/**
 * Short viewer id burned into the picture: the first 8 hex digits of the user id.
 * An admin finds the account with `WHERE id::text LIKE '<tag, lower case>%'`.
 */
export function viewerTag(userId: string): string {
  return userId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** "KERALA NEWS 24 · 1A2B3C4D": printable characters only, at most 40 of the organisation name. */
export function viewerMarkText(organization: string, userId: string): string {
  const name = organization
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .&'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .toUpperCase();
  return `${name || 'NEWSROOM'} · ${viewerTag(userId)}`;
}
