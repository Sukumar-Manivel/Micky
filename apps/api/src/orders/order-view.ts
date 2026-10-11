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
  /** Until when an unpaid checkout can be paid (the quoted price is honoured until then). */
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  /** Why the order is not (or no longer) PAID, e.g. the licence was sold meanwhile. */
  statusReason: string | null;
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
  /** The checkout must be paid before this moment; later payments are refunded. */
  expiresAt: string;
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
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    refundedAt: order.refundedAt?.toISOString() ?? null,
    statusReason: order.statusReason,
    downloadCount: order.downloadCount,
    media: {
      id: item.id,
      title: item.title,
      type: item.type,
      thumbnailUrl: urls.thumbnailUrl(item),
    },
  };
}
