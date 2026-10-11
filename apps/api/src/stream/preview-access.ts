// Who may watch a preview? One pure function, used both when a preview
// session is created and again on every playlist/key/segment request, so a
// link stops working as soon as the media is taken down, sold exclusively, or the
// channel loses its approval (instead of staying valid until the token expires).
import type { MediaStatus, Role } from '../db/schema.js';

export interface PreviewViewer {
  id: string;
  role: Role;
  /** Status of the CHANNEL user's organisation; null for other roles. */
  channelStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  /** True when this viewer bought the exclusive licence of the target media. */
  holdsExclusive?: boolean;
}

export interface PreviewTarget {
  uploaderId: string;
  status: MediaStatus;
  exclusiveSold?: boolean;
}

/**
 * - ok:        may watch.
 * - forbidden: a channel whose organisation is not approved (403, it knows its own status).
 * - sold:      an exclusive licence was sold to another newsroom: previews are closed
 *              for everyone except the owner, admins and the exclusive buyer (410 when
 *              a session is requested, 404 on the file routes).
 * - not-found: anything else (404, so we don't reveal that the media exists).
 */
export type PreviewDecision = 'ok' | 'forbidden' | 'sold' | 'not-found';

export function decidePreviewAccess(viewer: PreviewViewer, target: PreviewTarget): PreviewDecision {
  switch (viewer.role) {
    case 'ADMIN':
      // Admins review media in every state, so they can preview any of it.
      return 'ok';
    case 'UPLOADER':
      // Uploaders can check how their own preview looks, whatever its status
      // (except after a takedown).
      return viewer.id === target.uploaderId && target.status !== 'REMOVED' ? 'ok' : 'not-found';
    case 'CHANNEL':
      if (viewer.channelStatus !== 'APPROVED') return 'forbidden';
      if (target.status !== 'APPROVED') return 'not-found';
      // The exclusive buyer paid for the story being theirs alone: other newsrooms
      // must not keep watching (and recording) the preview.
      if (target.exclusiveSold && !viewer.holdsExclusive) return 'sold';
      return 'ok';
    default:
      return 'not-found';
  }
}
