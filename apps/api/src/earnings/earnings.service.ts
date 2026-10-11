import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../common/auth.decorators.js';
import {
  offsetOf,
  type Paginated,
  paginated,
  type PaginationQuery,
} from '../common/pagination.js';
import { loadUserView, type UserView } from '../auth/user-view.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import {
  channelProfiles,
  ledgerEntries,
  media,
  orders,
  payouts,
  uploaderProfiles,
} from '../db/schema.js';
import {
  type LedgerEntryView,
  type PayoutView,
  toLedgerEntryView,
  toPayoutView,
} from './earnings-views.js';

/** Anything that can run a query: the database itself or an open transaction. */
type Queryable = Pick<Database, 'select'>;

/**
 * An uploader's balance is never stored; it is always SUM(ledger_entries.amount).
 * A stored balance can drift from the history (a bug, a crash between two writes);
 * a computed one cannot, and every rupee is explained by a ledger row.
 */
export async function ledgerBalance(
  db: Queryable,
  uploaderId: string,
): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)`.mapWith(
        Number,
      ),
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.uploaderId, uploaderId));
  return row.balance;
}

export interface EarningsSummary {
  balance: number;
  totalEarned: number;
  totalPaidOut: number;
  pendingPayouts: number;
  salesCount: number;
  recent: LedgerEntryView[];
}

export interface SaleView {
  orderId: string;
  mediaId: string;
  mediaTitle: string;
  licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE';
  amount: number;
  uploaderShare: number;
  paidAt: string | null;
  buyerOrganization: string | null;
}

@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** PUT /me/payout-details */
  async setPayoutDetails(
    user: AuthUser,
    upiId: string,
  ): Promise<{ user: UserView }> {
    // Upsert: every uploader gets a profile at registration, but be robust if one is missing.
    await this.db
      .insert(uploaderProfiles)
      .values({ userId: user.id, upiId })
      .onConflictDoUpdate({ target: uploaderProfiles.userId, set: { upiId } });
    const view = await loadUserView(this.db, user.id);
    if (!view) throw new NotFoundException('Account not found');
    return { user: view };
  }

  /** GET /me/earnings: every total is a SQL aggregate, computed by Postgres. */
  async summary(user: AuthUser): Promise<EarningsSummary> {
    const [[ledger], [payoutTotals], recent] = await Promise.all([
      this.db
        .select({
          balance:
            sql<number>`coalesce(sum(${ledgerEntries.amount}), 0)`.mapWith(
              Number,
            ),
          totalEarned:
            sql<number>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.type} = 'SALE_CREDIT'), 0)`.mapWith(
              Number,
            ),
          salesCount:
            sql<number>`count(*) filter (where ${ledgerEntries.type} = 'SALE_CREDIT')`.mapWith(
              Number,
            ),
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.uploaderId, user.id)),
      this.db
        .select({
          totalPaidOut:
            sql<number>`coalesce(sum(${payouts.amount}) filter (where ${payouts.status} = 'PAID'), 0)`.mapWith(
              Number,
            ),
          pendingPayouts:
            sql<number>`coalesce(sum(${payouts.amount}) filter (where ${payouts.status} = 'REQUESTED'), 0)`.mapWith(
              Number,
            ),
        })
        .from(payouts)
        .where(eq(payouts.uploaderId, user.id)),
      this.ledgerPage(user.id, 10, 0),
    ]);
    return { ...ledger, ...payoutTotals, recent };
  }

  /** GET /me/ledger: newest first. */
  async ledger(
    user: AuthUser,
    query: PaginationQuery,
  ): Promise<Paginated<LedgerEntryView>> {
    const [items, [{ total }]] = await Promise.all([
      this.ledgerPage(user.id, query.pageSize, offsetOf(query)),
      this.db
        .select({ total: count() })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.uploaderId, user.id)),
    ]);
    return paginated(items, total, query);
  }

  /** GET /me/sales: paid orders of this uploader's media, newest first. */
  async sales(
    user: AuthUser,
    query: PaginationQuery,
  ): Promise<Paginated<SaleView>> {
    const where = and(eq(media.uploaderId, user.id), eq(orders.status, 'PAID'));
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          orderId: orders.id,
          mediaId: media.id,
          mediaTitle: media.title,
          licenseType: orders.licenseType,
          amount: orders.amount,
          uploaderShare: orders.uploaderShare,
          paidAt: orders.paidAt,
          buyerOrganization: channelProfiles.organization,
        })
        .from(orders)
        .innerJoin(media, eq(media.id, orders.mediaId))
        .leftJoin(channelProfiles, eq(channelProfiles.userId, orders.buyerId))
        .where(where)
        .orderBy(desc(orders.paidAt), desc(orders.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db
        .select({ total: count() })
        .from(orders)
        .innerJoin(media, eq(media.id, orders.mediaId))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({ ...r, paidAt: r.paidAt?.toISOString() ?? null })),
      total,
      query,
    );
  }

  /**
   * POST /me/payouts. The classic double-spend problem: two requests for ₹800 arrive
   * at the same moment against a balance of ₹1,000. Both read ₹1,000, both pass the
   * check, and the uploader is paid ₹1,600.
   *
   * Fix: inside the transaction, take a Postgres advisory lock keyed on the uploader.
   * The second request waits at the lock until the first commits, then reads the
   * balance that already includes the first PAYOUT_DEBIT. The lock is released
   * automatically at COMMIT or ROLLBACK ("xact" = transaction-scoped).
   *
   * We lock a key, not a row, because there is no single "balance row" to lock:
   * the balance is a SUM over many ledger rows, and new rows could be inserted.
   */
  async requestPayout(user: AuthUser, amount: number): Promise<PayoutView> {
    if (amount < this.config.minPayoutPaise) {
      throw new BadRequestException(
        `The minimum payout is ${formatRupees(this.config.minPayoutPaise)}`,
      );
    }

    const payout = await this.db.transaction(async (tx) => {
      // hashtext() maps the uuid to a 32-bit key. Two uploaders can share a key; that
      // only makes them wait for each other briefly, it never breaks correctness.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);

      const profile = await tx.query.uploaderProfiles.findFirst({
        where: eq(uploaderProfiles.userId, user.id),
        columns: { upiId: true },
      });
      if (!profile?.upiId) {
        throw new BadRequestException(
          'Add your UPI ID in payout details before requesting a payout',
        );
      }

      const balance = await ledgerBalance(tx, user.id);
      if (amount > balance) {
        throw new BadRequestException(
          `You can withdraw at most your balance of ${formatRupees(balance)}`,
        );
      }

      const [created] = await tx
        .insert(payouts)
        .values({
          uploaderId: user.id,
          amount,
          upiId: profile.upiId,
          status: 'REQUESTED',
        })
        .returning();
      // The money leaves the balance now, so it cannot be requested twice while an
      // admin is processing the payout. A rejected payout is returned with a PAYOUT_REVERSAL.
      await tx.insert(ledgerEntries).values({
        uploaderId: user.id,
        type: 'PAYOUT_DEBIT',
        amount: -amount,
        payoutId: created.id,
        note: `Payout to ${profile.upiId}`,
      });
      return created;
    });

    this.logger.log(
      `Payout ${payout.id} of ${amount} paise requested by ${user.id}`,
    );
    return toPayoutView(payout);
  }

  /** GET /me/payouts */
  async payouts(
    user: AuthUser,
    query: PaginationQuery,
  ): Promise<Paginated<PayoutView>> {
    const where = eq(payouts.uploaderId, user.id);
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(payouts)
        .where(where)
        .orderBy(desc(payouts.createdAt), desc(payouts.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(payouts).where(where),
    ]);
    return paginated(rows.map(toPayoutView), total, query);
  }

  /** Ledger rows with the title of the sold media (sale credits only), newest first. */
  private async ledgerPage(
    uploaderId: string,
    limit: number,
    offset: number,
  ): Promise<LedgerEntryView[]> {
    const rows = await this.db
      .select({ entry: ledgerEntries, mediaTitle: media.title })
      .from(ledgerEntries)
      .leftJoin(orders, eq(orders.id, ledgerEntries.orderId))
      .leftJoin(media, eq(media.id, orders.mediaId))
      .where(eq(ledgerEntries.uploaderId, uploaderId))
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => toLedgerEntryView(r.entry, r.mediaTitle));
  }
}

/** 12345 paise → "₹123.45" (for error messages only; the web app formats amounts itself). */
function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}
