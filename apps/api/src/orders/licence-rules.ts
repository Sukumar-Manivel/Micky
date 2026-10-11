import type { LicenseType, MediaStatus } from '../db/schema.js';

/** Everything the licence rules need to know about a media item, from the buyer's point of view. */
export interface LicenceState {
  mediaStatus: MediaStatus;
  exclusiveSold: boolean;
  /** PAID orders of this media by anyone (not counting the order being paid right now). */
  paidOrderCount: number;
  /** Whether this buyer already has a PAID order of this media. */
  buyerHasPaid: boolean;
}

/**
 * The licence rules from docs/API.md, as one pure function so they are easy to test
 * and are applied identically when an order is created and when it is paid.
 *
 * Returns a human-readable reason why the licence cannot be sold, or null if it can.
 */
export function licenceBlocker(
  state: LicenceState,
  licenseType: LicenseType,
): string | null {
  if (state.mediaStatus !== 'APPROVED') {
    return 'This media is no longer available for licensing';
  }
  if (state.buyerHasPaid) {
    return 'Your organisation has already bought a licence for this media';
  }
  if (state.exclusiveSold) {
    return 'This media has been licensed exclusively to another organisation';
  }
  if (licenseType === 'EXCLUSIVE' && state.paidOrderCount > 0) {
    return 'The exclusive licence is no longer available: this media has already been licensed to other organisations';
  }
  return null;
}

export function licenceLabel(licenseType: LicenseType): string {
  return licenseType === 'EXCLUSIVE'
    ? 'Exclusive licence'
    : 'Non-exclusive licence';
}
