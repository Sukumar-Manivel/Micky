// What the preview player does when hls.js reports a fatal error.
//
// The player must recover from the normal problems (a signed URL that expired, a decode
// glitch), but it must never retry forever: a browser that cannot decode H.264/AAC at all
// fails on every attempt, and an unbounded "recover → reload segment → fail" loop downloads
// the same segment many times a second for as long as the page stays open.
//
// Policy, following the hls.js documentation for media errors:
// - media error: recoverMediaError() once; if it fails again within a few seconds, try once
//   more after swapAudioCodec(); after that, give up and tell the viewer.
// - network (or any other) error: fetch a new preview session, since the usual cause is an
//   expired token. At most MAX_SESSION_REFRESHES times per minute, then give up.

export type HlsErrorAction = 'refresh-session' | 'recover-media' | 'swap-codec-and-recover' | 'give-up';

/** A second media error within this window means the first recovery did not help. */
export const MEDIA_RECOVERY_WINDOW_MS = 3_000;
export const MAX_SESSION_REFRESHES = 3;
const REFRESH_WINDOW_MS = 60_000;

export function createHlsErrorPolicy(now: () => number = () => Date.now()) {
  let lastMediaRecovery = -Infinity;
  let codecSwapped = false;
  let refreshes: number[] = [];

  return function decide(error: { type: string }): HlsErrorAction {
    const t = now();
    if (error.type === 'mediaError') {
      if (t - lastMediaRecovery > MEDIA_RECOVERY_WINDOW_MS) {
        lastMediaRecovery = t;
        return 'recover-media';
      }
      if (!codecSwapped) {
        codecSwapped = true;
        lastMediaRecovery = t;
        return 'swap-codec-and-recover';
      }
      return 'give-up';
    }
    refreshes = refreshes.filter((at) => t - at < REFRESH_WINDOW_MS);
    if (refreshes.length >= MAX_SESSION_REFRESHES) return 'give-up';
    refreshes.push(t);
    return 'refresh-session';
  };
}

/** Shown when the player gives up. */
export function unplayableMessage(errorType: string): string {
  return errorType === 'mediaError'
    ? 'This browser cannot play the preview video. Try the latest Chrome, Edge, Safari or Firefox.'
    : 'The preview could not be loaded. Check your connection and try again.';
}
