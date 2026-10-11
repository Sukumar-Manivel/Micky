import type { ledgerEntries, payouts } from '../db/schema.js';

type LedgerRow = typeof ledgerEntries.$inferSelect;
type PayoutRow = typeof payouts.$inferSelect;

/** docs/API.md LedgerEntryView. */
export interface LedgerEntryView {
  id: string;
  type: LedgerRow['type'];
  amount: number;
  note: string | null;
  createdAt: string;
  /** When the row counts towards the withdrawable balance (in the future while a sale credit is held). */
  availableAt: string;
  mediaTitle: string | null;
}

/** docs/API.md PayoutView. */
export interface PayoutView {
  id: string;
  amount: number;
  upiId: string;
  status: PayoutRow['status'];
  reference: string | null;
  note: string | null;
  createdAt: string;
  processedAt: string | null;
}

export function toLedgerEntryView(
  row: LedgerRow,
  mediaTitle: string | null,
): LedgerEntryView {
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    availableAt: row.availableAt.toISOString(),
    mediaTitle,
  };
}

export function toPayoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    amount: row.amount,
    upiId: row.upiId,
    status: row.status,
    reference: row.reference,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}
