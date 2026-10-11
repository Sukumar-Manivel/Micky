import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { UserView } from '../auth/user-view.js';
import { offsetOf, type Paginated, paginated } from '../common/pagination.js';
import { UrlService } from '../common/urls.service.js';
import { type MediaOwnerView, toMediaOwnerView } from '../common/views.js';
import { type Database, InjectDb } from '../db/db.module.js';
import {
  channelProfiles,
  ledgerEntries,
  media,
  orders,
  payouts,
  reports,
  users,
  verifications,
} from '../db/schema.js';
import { type PayoutView, toPayoutView } from '../earnings/earnings-views.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { type ReportView, toReportView } from '../reports/report-view.js';
import type {
  ListChannelsQuery,
  ListPayoutsQuery,
  ListReportsQuery,
  ResolveReportDto,
  ReviewQueueQuery,
} from './admin.dto.js';

type MediaRow = typeof media.$inferSelect;
type MediaStatus = MediaRow['status'];

export interface UploaderRef {
  id: string;
  name: string;
  email: string;
}

export interface AdminStats {
  users: { uploaders: number; channels: number; pendingChannels: number };
  media: {
    processing: number;
    inReview: number;
    approved: number;
    rejected: number;
  };
  orders: { paid: number; revenue: number; platformFees: number };
  payouts: { requested: number; requestedAmount: number };
  reports: { open: number };
}

/** `count(*) filter (where ...)` as a number: several counts in one table scan. */
const countWhere = (condition: SQL) =>
  sql<number>`count(*) filter (where ${condition})`.mapWith(Number);

/**
 * Moderation and back-office work. Every state change is a *conditional* update
 * ("... WHERE status = 'IN_REVIEW'"), so two admins clicking at the same time, or one
 * admin double-clicking, can never apply the same decision twice: the second update
 * matches zero rows and gets a 409.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly urls: UrlService,
    private readonly incidents: IncidentsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  async stats(): Promise<AdminStats> {
    const [[u], [m], [o], [p], [r]] = await Promise.all([
      this.db
        .select({
          uploaders: countWhere(sql`${users.role} = 'UPLOADER'`),
          channels: countWhere(sql`${users.role} = 'CHANNEL'`),
          pendingChannels: countWhere(
            sql`${channelProfiles.status} = 'PENDING'`,
          ),
        })
        .from(users)
        .leftJoin(channelProfiles, eq(channelProfiles.userId, users.id)),
      this.db
        .select({
          processing: countWhere(sql`${media.status} = 'PROCESSING'`),
          inReview: countWhere(sql`${media.status} = 'IN_REVIEW'`),
          approved: countWhere(sql`${media.status} = 'APPROVED'`),
          rejected: countWhere(sql`${media.status} = 'REJECTED'`),
        })
        .from(media),
      this.db
        .select({
          paid: count(),
          revenue: sql<number>`coalesce(sum(${orders.amount}), 0)`.mapWith(
            Number,
          ),
          platformFees:
            sql<number>`coalesce(sum(${orders.platformFee}), 0)`.mapWith(
              Number,
            ),
        })
        .from(orders)
        .where(eq(orders.status, 'PAID')),
      this.db
        .select({
          requested: count(),
          requestedAmount:
            sql<number>`coalesce(sum(${payouts.amount}), 0)`.mapWith(Number),
        })
        .from(payouts)
        .where(eq(payouts.status, 'REQUESTED')),
      this.db
        .select({ open: count() })
        .from(reports)
        .where(eq(reports.status, 'OPEN')),
    ]);
    return { users: u, media: m, orders: o, payouts: p, reports: r };
  }

  // ---------------------------------------------------------------------------
  // Media moderation
  // ---------------------------------------------------------------------------

  /** Media waiting for a decision, oldest first, with full verification metadata. */
  async reviewQueue(
    query: ReviewQueueQuery,
  ): Promise<Paginated<MediaOwnerView & { uploader: UploaderRef }>> {
    const where = and(
      eq(media.status, 'IN_REVIEW'),
      query.risk ? eq(verifications.riskLevel, query.risk) : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          media,
          verification: verifications,
          uploader: { id: users.id, name: users.name, email: users.email },
        })
        .from(media)
        .innerJoin(users, eq(users.id, media.uploaderId))
        .leftJoin(verifications, eq(verifications.mediaId, media.id))
        .where(where)
        .orderBy(asc(media.createdAt), asc(media.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db
        .select({ total: count() })
        .from(media)
        .leftJoin(verifications, eq(verifications.mediaId, media.id))
        .where(where),
    ]);
    return paginated(
      rows.map((r) => ({
        ...toMediaOwnerView(r.media, {
          urls: this.urls,
          verification: r.verification,
          includeMetadata: true,
        }),
        uploader: r.uploader,
      })),
      total,
      query,
    );
  }

  /** IN_REVIEW → APPROVED: the media goes on sale and channels are notified live. */
  async approveMedia(
    mediaId: string,
    note: string | undefined,
  ): Promise<MediaOwnerView> {
    const approved = await this.transitionMedia(
      mediaId,
      'IN_REVIEW',
      'APPROVED',
      note ?? null,
    );

    // Side effects run only after the update is committed, so listeners never see
    // an event for a change that was rolled back.
    if (approved.incidentId)
      await this.incidents.recompute(approved.incidentId);
    this.realtime.emitToChannels({
      type: 'media.approved',
      mediaId: approved.id,
      incidentId: approved.incidentId,
      title: approved.title,
      category: approved.category,
    });
    this.logger.log(`Media ${mediaId} approved`);
    return this.mediaView(approved);
  }

  /** IN_REVIEW → REJECTED. The note is shown to the uploader. */
  async rejectMedia(mediaId: string, note: string): Promise<MediaOwnerView> {
    const rejected = await this.transitionMedia(
      mediaId,
      'IN_REVIEW',
      'REJECTED',
      note,
    );
    this.logger.log(`Media ${mediaId} rejected`);
    return this.mediaView(rejected);
  }

  /** Takedown of APPROVED media (e.g. after a court order or a valid complaint). */
  async removeMedia(mediaId: string, note: string): Promise<MediaOwnerView> {
    const removed = await this.transitionMedia(
      mediaId,
      'APPROVED',
      'REMOVED',
      note,
    );
    if (removed.incidentId) await this.incidents.recompute(removed.incidentId);
    this.logger.warn(`Media ${mediaId} taken down: ${note}`);
    return this.mediaView(removed);
  }

  /**
   * Moves media from one status to another in one conditional UPDATE.
   * Zero rows updated means it does not exist (404) or is not in `from` (409).
   */
  private async transitionMedia(
    mediaId: string,
    from: MediaStatus,
    to: MediaStatus,
    note: string | null,
  ): Promise<MediaRow> {
    const [updated] = await this.db
      .update(media)
      .set({ status: to, reviewNote: note, reviewedAt: new Date() })
      .where(and(eq(media.id, mediaId), eq(media.status, from)))
      .returning();
    if (updated) return updated;

    const current = await this.db.query.media.findFirst({
      where: eq(media.id, mediaId),
      columns: { status: true },
    });
    if (!current) throw new NotFoundException('Media not found');
    throw new ConflictException(
      `Only ${from} media can be changed to ${to}; this media is ${current.status}`,
    );
  }

  /** MediaOwnerView with verification (incl. metadata) and sales figures. */
  private async mediaView(row: MediaRow): Promise<MediaOwnerView> {
    const [verification, [sales]] = await Promise.all([
      this.db.query.verifications.findFirst({
        where: eq(verifications.mediaId, row.id),
      }),
      this.db
        .select({
          salesCount: count(),
          earned:
            sql<number>`coalesce(sum(${orders.uploaderShare}), 0)`.mapWith(
              Number,
            ),
        })
        .from(orders)
        .where(and(eq(orders.mediaId, row.id), eq(orders.status, 'PAID'))),
    ]);
    return toMediaOwnerView(row, {
      urls: this.urls,
      verification: verification ?? null,
      salesCount: sales.salesCount,
      earned: sales.earned,
      includeMetadata: true,
    });
  }

  // ---------------------------------------------------------------------------
  // News channel approval
  // ---------------------------------------------------------------------------

  async listChannels(query: ListChannelsQuery): Promise<Paginated<UserView>> {
    const where = query.status
      ? eq(channelProfiles.status, query.status)
      : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({ user: users, channel: channelProfiles })
        .from(channelProfiles)
        .innerJoin(users, eq(users.id, channelProfiles.userId))
        .where(where)
        .orderBy(asc(channelProfiles.createdAt), asc(users.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(channelProfiles).where(where),
    ]);
    return paginated(
      rows.map((r) => toChannelUserView(r.user, r.channel)),
      total,
      query,
    );
  }

  async approveChannel(userId: string): Promise<UserView> {
    return this.setChannelStatus(userId, 'APPROVED', null);
  }

  async rejectChannel(userId: string, note: string): Promise<UserView> {
    return this.setChannelStatus(userId, 'REJECTED', note);
  }

  /** Approving a rejected channel, or revoking an approved one, are both allowed. */
  private async setChannelStatus(
    userId: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
  ): Promise<UserView> {
    const [channel] = await this.db
      .update(channelProfiles)
      .set({ status, reviewNote: note })
      .where(eq(channelProfiles.userId, userId))
      .returning();
    if (!channel) throw new NotFoundException('News channel not found');
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) throw new NotFoundException('News channel not found');
    this.logger.log(`Channel ${userId} ${status}`);
    return toChannelUserView(user, channel);
  }

  // ---------------------------------------------------------------------------
  // Payouts (paid manually by UPI in batches, then marked here)
  // ---------------------------------------------------------------------------

  async listPayouts(
    query: ListPayoutsQuery,
  ): Promise<Paginated<PayoutView & { uploader: UploaderRef }>> {
    const where = query.status ? eq(payouts.status, query.status) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          payout: payouts,
          uploader: { id: users.id, name: users.name, email: users.email },
        })
        .from(payouts)
        .innerJoin(users, eq(users.id, payouts.uploaderId))
        .where(where)
        // Oldest first: requests are paid in the order they were made.
        .orderBy(asc(payouts.createdAt), asc(payouts.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(payouts).where(where),
    ]);
    return paginated(
      rows.map((r) => ({ ...toPayoutView(r.payout), uploader: r.uploader })),
      total,
      query,
    );
  }

  /** REQUESTED → PAID, after the admin has actually sent the money. The ledger was already debited. */
  async markPayoutPaid(
    payoutId: string,
    reference: string,
  ): Promise<PayoutView> {
    const [paid] = await this.db
      .update(payouts)
      .set({ status: 'PAID', reference, processedAt: new Date() })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, 'REQUESTED')))
      .returning();
    if (!paid) return this.throwPayoutNotRequested(payoutId);
    this.logger.log(`Payout ${payoutId} marked paid (${reference})`);
    return toPayoutView(paid);
  }

  /**
   * REQUESTED → REJECTED, and the money goes back to the uploader's balance as a
   * PAYOUT_REVERSAL ledger entry. Both happen in one transaction, and the status
   * change is conditional, so a payout can be reversed at most once.
   */
  async rejectPayout(payoutId: string, note: string): Promise<PayoutView> {
    const rejected = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(payouts)
        .set({ status: 'REJECTED', note, processedAt: new Date() })
        .where(and(eq(payouts.id, payoutId), eq(payouts.status, 'REQUESTED')))
        .returning();
      if (!row) return undefined;
      await tx.insert(ledgerEntries).values({
        uploaderId: row.uploaderId,
        type: 'PAYOUT_REVERSAL',
        amount: row.amount, // positive: gives back exactly what PAYOUT_DEBIT took
        payoutId: row.id,
        note: `Payout rejected: ${note}`,
      });
      return row;
    });
    if (!rejected) return this.throwPayoutNotRequested(payoutId);
    this.logger.log(`Payout ${payoutId} rejected and reversed`);
    return toPayoutView(rejected);
  }

  private async throwPayoutNotRequested(payoutId: string): Promise<never> {
    const current = await this.db.query.payouts.findFirst({
      where: eq(payouts.id, payoutId),
      columns: { status: true },
    });
    if (!current) throw new NotFoundException('Payout not found');
    throw new ConflictException(
      `This payout has already been processed (${current.status})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Grievance reports
  // ---------------------------------------------------------------------------

  async listReports(query: ListReportsQuery): Promise<Paginated<ReportView>> {
    const where = query.status ? eq(reports.status, query.status) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(reports)
        .where(where)
        // Oldest first: the legal deadlines run from when the report was received.
        .orderBy(asc(reports.createdAt), asc(reports.id))
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(reports).where(where),
    ]);
    return paginated(rows.map(toReportView), total, query);
  }

  /**
   * Closes an OPEN report as RESOLVED, optionally taking the media down in the same
   * transaction (both happen, or neither does).
   */
  async resolveReport(
    reportId: string,
    dto: ResolveReportDto,
  ): Promise<ReportView> {
    const result = await this.db.transaction(async (tx) => {
      const [report] = await tx
        .update(reports)
        .set({
          status: 'RESOLVED',
          resolution: dto.resolution,
          resolvedAt: new Date(),
        })
        .where(and(eq(reports.id, reportId), eq(reports.status, 'OPEN')))
        .returning();
      if (!report) return undefined;

      let removed: MediaRow | undefined;
      if (dto.removeMedia) {
        if (!report.mediaId)
          throw new ConflictException(
            'This report is not about a specific media item',
          );
        // Any status except REMOVED can be taken down (even media still in review).
        [removed] = await tx
          .update(media)
          .set({
            status: 'REMOVED',
            reviewNote: `Removed after report: ${dto.resolution}`,
            reviewedAt: new Date(),
          })
          .where(and(eq(media.id, report.mediaId), ne(media.status, 'REMOVED')))
          .returning();
      }
      return { report, removed };
    });
    if (!result) return this.throwReportNotOpen(reportId);

    const { report, removed } = result;
    if (removed) {
      this.logger.warn(
        `Media ${removed.id} taken down after report ${report.id}`,
      );
      if (removed.incidentId)
        await this.incidents.recompute(removed.incidentId);
    }
    return toReportView(report);
  }

  async dismissReport(
    reportId: string,
    resolution: string,
  ): Promise<ReportView> {
    const [report] = await this.db
      .update(reports)
      .set({ status: 'DISMISSED', resolution, resolvedAt: new Date() })
      .where(and(eq(reports.id, reportId), eq(reports.status, 'OPEN')))
      .returning();
    if (!report) return this.throwReportNotOpen(reportId);
    return toReportView(report);
  }

  private async throwReportNotOpen(reportId: string): Promise<never> {
    const current = await this.db.query.reports.findFirst({
      where: eq(reports.id, reportId),
      columns: { status: true },
    });
    if (!current) throw new NotFoundException('Report not found');
    throw new ConflictException(
      `This report has already been handled (${current.status})`,
    );
  }
}

function toChannelUserView(
  user: typeof users.$inferSelect,
  channel: typeof channelProfiles.$inferSelect,
): UserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    channel: {
      organization: channel.organization,
      website: channel.website,
      status: channel.status,
    },
    uploader: null,
  };
}
