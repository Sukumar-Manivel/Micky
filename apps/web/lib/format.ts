// Display helpers for dates, labels and durations. Times are shown in India Standard Time,
// because both witnesses and newsrooms are in India, whatever the device clock says.

import type { Category, LicenseType, MediaStatus, ReportReason } from './types';

const IST = 'Asia/Kolkata';

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric' });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "5 minutes ago", "yesterday". `now` is injectable for tests. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

export function formatDuration(sec: number | null): string | null {
  if (sec === null) return null;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  FIRE: 'Fire',
  ACCIDENT: 'Accident',
  FLOOD: 'Flood',
  WEATHER: 'Weather',
  PROTEST: 'Protest',
  CRIME: 'Crime',
  INFRASTRUCTURE: 'Infrastructure',
  OTHER: 'Other',
};

export const STATUS_LABEL: Record<MediaStatus, string> = {
  PROCESSING: 'Processing',
  IN_REVIEW: 'In review',
  APPROVED: 'On sale',
  REJECTED: 'Not approved',
  FAILED: 'Failed',
  REMOVED: 'Removed',
};

export const LICENSE_LABEL: Record<LicenseType, string> = {
  NON_EXCLUSIVE: 'Non-exclusive licence',
  EXCLUSIVE: 'Exclusive licence',
};

/** `datetime-local` inputs want "YYYY-MM-DDTHH:mm" in local time, without a zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(km < 10 ? 1 : 0)} km away`;
}

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  PRIVACY: 'Privacy',
  COPYRIGHT: 'Copyright',
  FAKE: 'Fake or misleading',
  GRAPHIC: 'Graphic content',
  OTHER: 'Other',
};
