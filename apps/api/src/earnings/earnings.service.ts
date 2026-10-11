import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
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
  payoutDetailChanges,
  payouts,
  uploaderProfiles,
  users,
} from '../db/schema.js';
import {
  type LedgerEntryView,
  type PayoutView,
  toLedgerEntryView,
  toPayoutView,
} from './earnings-views.js';
import type { PayoutDetailsDto } from './earnings.dto.js';
import { ledgerBalances } from './ledger.js';
import { saleCreditHoldMs, upiCoolingOffMs } from './money-policy.js';

export interface PayoutDetailsView {
  upiId: string | null;
  /** When the UPI ID was last changed from a previous one (null if never changed). */
  changedAt: string | null;
  /** Payouts are blocked until then after a change (null when there is no restriction). */
  payoutsAllowedFrom: string | null;
}

export interface EarningsSummary {
  /** Everything in the ledger. May be negative after a refund or chargeback. */
  balance: number;
  /** What can be withdrawn now. */
  available: number;
  /** Sale credits still inside the hold period. */
  onHold: number;
  /** When the next held credit becomes available. */
  nextReleaseAt: string | null;
  /** How long sale credits are held, in days. */
  holdDays: number;
  /** Net sales: credits minus reversed sales. */
  totalEarned: number;
  totalPaidOut: number;
  pendingPayouts: number;
  /** Sales that still stand (refunded or charged-back sales are not counted). */
  salesCount: number;
  payoutDetails: PayoutDetailsView;
  recent: LedgerEntryView[];
}

export interface SaleView {
  orderId: string;
  mediaId: string;
  mediaTitle: string;
  licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE';
  /** PAID, or REFUNDED / DISPUTED when the sale was reversed. */
  status: 'PAID' | 'REFUNDED' | 'DISPUTED';
  amount: number;
  uploaderShare: number;
  paidAt: string | null;
  buyerOrganization: string | null;
}

/** Sale rows shown to the uploader: standing sales and the ones that were reversed. */
const SALE_STATUSES = ['PAID', 'REFUNDED', 'DISPUTED'] as const;

@Injectable()
export class EarningsService {
  private readonly logger = new Logger(EarningsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /**
   * PUT /me/payout-details (review M4). Changing where money goes:
   * - needs the current password, so a stolen access token is not enough;
   * - starts a cooling-off period during which no payout can be requested, so the real
   *   owner has time to notice (the change is listed on their earnings page and flagged
   *   to admins in the payout queue);
   * - is recorded in `payout_detail_changes` (old and new ID, IP, user agent).
   * Setting the first UPI ID needs the password but has no cooling-off: there is no
   * earlier destination to divert money from.
   */
  async setPayoutDetails(
    user: AuthUser,
    dto: PayoutDetailsDto,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ user: UserView; payoutDetails: PayoutDetailsView }> {
    const account = await this.db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { passwordHash: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    if (!(await bcrypt.compare(dto.currentPassword, account.passwordHash))) {
      this.logger.warn(
        `Wrong password when changing the UPI ID of ${user.id} (ip ${meta.ip ?? '?'})`,
      );
      throw new ForbiddenException('Your current password is not correct');
    }

    const changed = await this.db.transaction(async (tx) => {
      // Same lock as payouts: a payout request and a UPI change never interleave.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${user.id}))`);
      const profile = await tx.query.uploaderProfiles.findFirst({
        where: eq(uploaderProfiles.userId, user.id),
      });
      const oldUpiId = profile?.upiId ?? null;
      if (oldUpiId === dto.upiId) return null;

      const upiChangedAt = oldUpiId
        ? new Date()
        : (profile?.upiChangedAt ?? null);
      // Upsert: every uploader gets a profile at registration, but be robust if one is missing.
      await tx
        .insert(uploaderProfiles)
        .values({ userId: user.id, upiId: dto.upiId, upiChangedAt })
        .onConflictDoUpdate({
          target: uploaderProfiles.userId,
          set: { upiId: dto.upiId, upiChangedAt },
        });
      await tx.insert(payoutDetailChanges).values({
        userId: user.id,
        oldUpiId,
        newUpiId: dto.upiId,
        ip: meta.ip?.slice(0, 100) ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
      });
      return { oldUpiId };
    });
    if (changed?.oldUpiId) {
      // TODO(lead): also email the account owner once the platform can send email.
      this.logger.warn(
        `UPI ID of uploader ${user.id} changed (ip ${meta.ip ?? '?'}); payouts paused for the cooling-off period`,
      );
    }

    const view = await loadUserView(this.db, user.id);
    if (!view) throw new NotFoundException('Account not found');
    return { user: view, payoutDetails: await this.payoutDetails(user.id) };
  }

  /** GET /me/earnings: every total is a SQL aggregate, computed by Postgres. */
  async summary(user: AuthUser): Promise<EarningsSummary> {
    const [balances, [ledger], [payoutTotals], payoutDetails, recent] =
      await Promise.all([
        ledgerBalances(this.db, user.id),
        this.db
          .select({
            totalEarned:
              sql<number>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.type} in ('SALE_CREDIT', 'SALE_REVERSAL', 'SALE_REINSTATEMENT')), 0)`.mapWith(
                Number,
              ),
            salesCount:
              sql<number>`count(*) filter (where ${ledgerEntries.type} in ('SALE_CREDIT', 'SALE_REINSTATEMENT')) - count(*) filter (where ${ledgerEntries.type} = 'SALE_REVERSAL')`.mapWith(
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
        this.payoutDetails(user.id),
        this.ledgerPage(user.id, 10, 0),
      ]);
    return {
      balance: balances.balance,
      available: balances.available,
      onHold: balances.onHold,
      nextReleaseAt: balances.nextReleaseAt?.toISOString() ?? null,
      holdDays: Math.round(saleCreditHoldMs(this.config) / 86_400_000),
      ...ledger,
      ...payoutTotals,
      payoutDetails,
      recent,
    };
  }

  private async payoutDetails(userId: string): Promise<PayoutDetailsView> {
    const profile = await this.db.query.uploaderProfiles.findFirst({
      where: eq(uploaderProfiles.userId, userId),
      columns: { upiId: true, upiChangedAt: true },
    });
    const changedAt = profile?.upiChangedAt ?? null;
    const allowedFrom = changedAt
      ? new Date(changedAt.getTime() + upiCoolingOffMs(this.config))
      : null;
    return {
      upiId: profile?.upiId ?? null,
      changedAt: changedAt?.toISOString() ?? null,
      payoutsAllowedFrom:
        allowedFrom && allowedFrom.getTime() > Date.now()
          ? allowedFrom.toISOString()
          : null,
    };
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

  /** GET /me/sales: sold orders of this uploader's media (including reversed ones), newest first. */
  async sales(
    user: AuthUser,
    query: PaginationQuery,
  ): Promise<Paginated<SaleView>> {
    const where = and(
      eq(media.uploaderId, user.id),
      inArray(orders.status, [...SALE_STATUSES]),
    );
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          orderId: orders.id,
          mediaId: media.id,
          mediaTitle: media.title,
          licenseType: orders.licenseType,
          status: orders.status,
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
      rows.map((r) => ({
        ...r,
        status: r.status as SaleView['status'],
        paidAt: r.paidAt?.toISOString() ?? null,
      })),
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
   *
   * Only the *available* balance can be withdrawn: sale credits are held for a while
   * (refunds and chargebacks), and nothing can be withdrawn during the cooling-off
   * period after the UPI ID was changed (review H2, M4).
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
        columns: { upiId: true, upiChangedAt: true },
      });
      if (!profile?.upiId) {
        throw new BadRequestException(
          'Add your UPI ID in payout details before requesting a payout',
        );
      }
      if (profile.upiChangedAt) {
        const allowedFrom =
          profile.upiChangedAt.getTime() + upiCoolingOffMs(this.config);
        if (allowedFrom > Date.now()) {
          throw new BadRequestException(
            `Your UPI ID was changed recently. For your safety, payouts to the new ID are possible from ${new Date(allowedFrom).toISOString()}`,
          );
        }
      }

      const { available, onHold } = await ledgerBalances(tx, user.id);
      if (amount > available) {
        const held =
          onHold > 0
            ? ` (${formatRupees(onHold)} more is on hold and becomes available ${Math.round(saleCreditHoldMs(this.config) / 86_400_000)} days after each sale)`
            : '';
        throw new BadRequestException(
          `You can withdraw at most your available balance of ${formatRupees(Math.max(0, available))}${held}`,
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
