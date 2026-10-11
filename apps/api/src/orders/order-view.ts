import type { UrlService } from '../common/urls.service.js';
import type { LicenseType, media, orders } from '../db/schema.js';

export type OrderRow = typeof orders.$inferSelect;
/** The media columns an OrderView needs (select only these to keep queries small). */
export type OrderMediaRow = Pick<
  typeof media.$inferSelect,
  'id' | 'title' | 'type' | 'thumbKey'
>;

/** API shape of an order (docs/API.md, OrderView). */
export interface OrderView {
  id: string;
  status: OrderRow['status'];
  licenseType: LicenseType;
  amount: number;
  currency: 'INR';
  createdAt: string;
  paidAt: string | null;
  downloadCount: number;
  media: {
    id: string;
    title: string;
    type: OrderMediaRow['type'];
    thumbnailUrl: string | null;
  };
}

/** API shape returned by POST /orders: what the browser needs to open the checkout. */
export interface CheckoutView {
  orderId: string;
  amount: number;
  currency: 'INR';
  provider: 'razorpay' | 'mock';
  razorpay?: { keyId: string; orderId: string };
  description: string;
}

export function toOrderView(
  order: OrderRow,
  item: OrderMediaRow,
  urls: UrlService,
): OrderView {
  return {
    id: order.id,
    status: order.status,
    licenseType: order.licenseType,
    amount: order.amount,
    currency: 'INR',
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    downloadCount: order.downloadCount,
    media: {
      id: item.id,
      title: item.title,
      type: item.type,
      thumbnailUrl: urls.thumbnailUrl(item),
    },
  };
}

/**
 * A safe download file name: the media title reduced to letters, digits and dashes,
 * plus the original file's extension. Example: "Fire near Gandhipuram!" + "IMG_1.MOV"
 * → "fire-near-gandhipuram.mov".
 */
export function downloadFileName(title: string, originalName: string): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 80) || 'firstframe-media';
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(originalName)?.[1]?.toLowerCase();
  return ext ? `${base}.${ext}` : base;
}
