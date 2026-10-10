import type { LicenseType } from '../db/schema.js';

/** Default prices in paise, used when the uploader does not set their own. */
export const DEFAULT_PRICES = {
  VIDEO: { NON_EXCLUSIVE: 1_500_00, EXCLUSIVE: 5_000_00 },
  PHOTO: { NON_EXCLUSIVE: 500_00, EXCLUSIVE: 2_000_00 },
} as const;

/** Price limits uploaders can choose from, in paise. */
export const MIN_PRICE_PAISE = 100_00; // ₹100
export const MAX_PRICE_PAISE = 1_00_000_00; // ₹1,00,000

/**
 * Splits a sale between the platform and the uploader.
 * The platform fee is rounded down so the uploader never loses a paisa to rounding.
 */
export function splitSale(amount: number, platformFeePercent: number) {
  const platformFee = Math.floor((amount * platformFeePercent) / 100);
  return { platformFee, uploaderShare: amount - platformFee };
}

export function priceFor(
  item: { priceNonExclusive: number; priceExclusive: number },
  license: LicenseType,
): number {
  return license === 'EXCLUSIVE' ? item.priceExclusive : item.priceNonExclusive;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}
