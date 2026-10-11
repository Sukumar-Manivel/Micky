import type { AppConfig } from '../config/app-config.js';

/**
 * Time-based money rules of the marketplace, in one place.
 *
 * - EARNINGS_HOLD_DAYS (AppConfig.earningsHoldDays, default 7): sale credits are held.
 * - PAYOUT_COOLDOWN_HOURS (AppConfig.payoutCooldownHours, default 24): no payouts after a
 *   UPI change.
 * - The checkout window is a product constant (30 minutes), see CHECKOUT_TTL_MINUTES.
 */
export const CHECKOUT_TTL_MINUTES = 30;

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a sale credit is held before it can be withdrawn. Card payments can be
 * refunded or charged back after the sale; holding the uploader's share for a while
 * means most reversals happen before the money has left the platform.
 */
export function saleCreditHoldMs(config: AppConfig): number {
  return Math.max(0, config.earningsHoldDays) * 24 * HOUR_MS;
}

/** After the UPI ID changes, payouts wait this long (protects against a stolen session). */
export function upiCoolingOffMs(config: AppConfig): number {
  return Math.max(0, config.payoutCooldownHours) * HOUR_MS;
}

/** An unpaid checkout can be paid for this long; the quoted price is honoured until then. */
export function checkoutTtlMs(_config: AppConfig): number {
  return CHECKOUT_TTL_MINUTES * 60 * 1000;
}
