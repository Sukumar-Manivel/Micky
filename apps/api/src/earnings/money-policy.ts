import type { AppConfig } from '../config/app-config.js';

/**
 * Time-based money rules of the marketplace, in one place.
 *
 * TODO(lead): these belong in AppConfig (src/config/app-config.ts). Until the fields
 * below exist there, the defaults are used. Once they are added, nothing here changes:
 * the getters already prefer the AppConfig value.
 *   readonly saleCreditHoldDays = int('SALE_CREDIT_HOLD_DAYS', 7);
 *   readonly upiChangeCoolingOffHours = int('UPI_CHANGE_COOLING_OFF_HOURS', 24);
 *   readonly checkoutTtlMinutes = int('CHECKOUT_TTL_MINUTES', 30);
 */
export const DEFAULT_SALE_CREDIT_HOLD_DAYS = 7;
export const DEFAULT_UPI_CHANGE_COOLING_OFF_HOURS = 24;
export const DEFAULT_CHECKOUT_TTL_MINUTES = 30;

interface MoneyPolicyConfig {
  saleCreditHoldDays?: number;
  upiChangeCoolingOffHours?: number;
  checkoutTtlMinutes?: number;
}

const HOUR_MS = 60 * 60 * 1000;

function settings(config: AppConfig): MoneyPolicyConfig {
  return config as unknown as MoneyPolicyConfig;
}

/**
 * How long a sale credit is held before it can be withdrawn. Card payments can be
 * refunded or charged back after the sale; holding the uploader's share for a while
 * means most reversals happen before the money has left the platform.
 */
export function saleCreditHoldMs(config: AppConfig): number {
  const days =
    settings(config).saleCreditHoldDays ?? DEFAULT_SALE_CREDIT_HOLD_DAYS;
  return Math.max(0, days) * 24 * HOUR_MS;
}

/** After the UPI ID changes, payouts wait this long (protects against a stolen session). */
export function upiCoolingOffMs(config: AppConfig): number {
  const hours =
    settings(config).upiChangeCoolingOffHours ??
    DEFAULT_UPI_CHANGE_COOLING_OFF_HOURS;
  return Math.max(0, hours) * HOUR_MS;
}

/** An unpaid checkout can be paid for this long; the quoted price is honoured until then. */
export function checkoutTtlMs(config: AppConfig): number {
  const minutes =
    settings(config).checkoutTtlMinutes ?? DEFAULT_CHECKOUT_TTL_MINUTES;
  return Math.max(1, minutes) * 60 * 1000;
}
