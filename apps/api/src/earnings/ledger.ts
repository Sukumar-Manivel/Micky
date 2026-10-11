import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/db.module.js';
import { ledgerEntries } from '../db/schema.js';

/** Anything that can run a query: the database itself or an open transaction. */
type Queryable = Pick<Database, 'select'>;
type Writable = Pick<Database, 'select' | 'insert'>;

export interface LedgerBalances {
  /** Everything: SUM(amount). May be negative after a reversal. */
  balance: number;
  /** What can be withdrawn now: rows whose available_at has passed. */
  available: number;
  /** Sale credits still inside their hold period (balance − available). */
  onHold: number;
  /** When the next held credit becomes available, if any. */
  nextReleaseAt: Date | null;
}

/**
 * An uploader's balance is never stored; it is always computed from the ledger.
 * A stored balance can drift from the history (a bug, a crash between two writes);
 * a computed one cannot, and every rupee is explained by a ledger row.
 *
 * "Available" counts a row once its `available_at` has passed. Sale credits get
 * `available_at = paidAt + hold`; debits, payout reversals and adjustments count at
 * once; a sale reversal copies the `available_at` of the credit it cancels, so a
 * refund inside the hold period simply makes both rows disappear from "on hold"
 * together, and a refund after the hold reduces the available balance immediately.
 */
export async function ledgerBalances(
  db: Queryable,
  uploaderId: string,
  now: Date = new Date(),
): Promise<LedgerBalances> {
  const [row] = await db
    .select({
      balance: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)`.mapWith(
        Number,
      ),
      available:
        sql<number>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.availableAt} <= ${now}), 0)`.mapWith(
          Number,
        ),
      nextReleaseAt:
        sql<Date | null>`min(${ledgerEntries.availableAt}) filter (where ${ledgerEntries.availableAt} > ${now} and ${ledgerEntries.amount} > 0)`.mapWith(
          (v: string | Date | null) => (v === null ? null : new Date(v)),
        ),
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.uploaderId, uploaderId));
  return {
    balance: row.balance,
    available: row.available,
    onHold: row.balance - row.available,
    nextReleaseAt: row.nextReleaseAt ?? null,
  };
}

/**
 * Writes the uploader's SALE_CREDIT for a paid order, held until `availableAt`.
 * Idempotent: the partial unique index "one SALE_CREDIT per order" turns a second
 * attempt into a no-op.
 */
export async function writeSaleCredit(
  tx: Writable,
  input: {
    uploaderId: string;
    orderId: string;
    amount: number;
    note: string;
    availableAt: Date;
  },
): Promise<void> {
  await tx
    .insert(ledgerEntries)
    .values({ type: 'SALE_CREDIT', ...input })
    .onConflictDoNothing({
      target: ledgerEntries.orderId,
      where: sql`${ledgerEntries.type} = 'SALE_CREDIT'`,
    });
}

/**
 * Cancels the sale credit of an order (refund or chargeback) with a negative
 * SALE_REVERSAL of the same amount. Returns false if there was no credit or it was
 * already reversed (the unique index "one row of each type per order" guarantees
 * at most one reversal, even if two webhooks race).
 */
export async function writeSaleReversal(
  tx: Writable,
  orderId: string,
  note: string,
): Promise<boolean> {
  const [credit] = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.orderId, orderId),
        eq(ledgerEntries.type, 'SALE_CREDIT'),
      ),
    );
  if (!credit) return false;
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      uploaderId: credit.uploaderId,
      type: 'SALE_REVERSAL',
      amount: -credit.amount,
      orderId,
      note,
      // Same moment as the credit: inside the hold the two cancel out in "on hold";
      // after the hold the reversal counts against the available balance at once.
      availableAt: credit.availableAt,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  return inserted.length > 0;
}

/**
 * A chargeback the platform won: the uploader's share comes back, available when the
 * original credit would have been. At most once per order.
 */
export async function writeSaleReinstatement(
  tx: Writable,
  orderId: string,
  note: string,
): Promise<boolean> {
  const [reversal] = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.orderId, orderId),
        eq(ledgerEntries.type, 'SALE_REVERSAL'),
      ),
    );
  if (!reversal) return false;
  const inserted = await tx
    .insert(ledgerEntries)
    .values({
      uploaderId: reversal.uploaderId,
      type: 'SALE_REINSTATEMENT',
      amount: -reversal.amount,
      orderId,
      note,
      // Never earlier than the original hold would have ended.
      availableAt: reversal.availableAt,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerEntries.id });
  return inserted.length > 0;
}
