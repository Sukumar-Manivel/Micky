import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import ngeohash from 'ngeohash';
import { publicCoordinate } from '../common/views.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { type Category, incidents, media, verifications } from '../db/schema.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { trendScore } from './trend.js';

/** Uploads captured within this many hours of an incident's time span join it. */
export const CLUSTER_WINDOW_HOURS = 2;
/** Incidents seen within this many hours get their trend score refreshed by the scheduled job. */
export const ACTIVE_HOURS = 72;

/** Media that still count as evidence for an incident's time span (not rejected/failed/removed). */
const LIVE_STATUSES = ['PROCESSING', 'IN_REVIEW', 'APPROVED'] as const;

const CATEGORY_LABEL: Record<Category, string> = {
  FIRE: 'Fire',
  ACCIDENT: 'Accident',
  FLOOD: 'Flood',
  WEATHER: 'Severe weather',
  PROTEST: 'Protest',
  CRIME: 'Crime',
  INFRASTRUCTURE: 'Infrastructure incident',
  OTHER: 'Incident',
};

/**
 * CONTRACT (owned by the media/processing builder).
 * Groups media into incidents and keeps incident counters and trend scores fresh.
 * Other modules (admin, market) call these methods; keep the signatures stable.
 *
 * Clustering: a geohash turns a latitude/longitude into a short string where
 * nearby points share a prefix. At precision 6 one cell is about 1.2 × 0.6 km.
 * A point near a cell edge can be metres away from a point in the next cell,
 * so we search the media's own cell plus its 8 neighbours.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    // Optional: the API process has the realtime gateway, the worker process does not.
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /**
   * Attaches a processed media item to an existing nearby incident
   * (same or neighbouring geohash-6 cell, captured within the clustering window),
   * or creates a new incident. Returns the incident id.
   */
  async assignIncident(mediaId: string): Promise<string> {
    const incidentId = await this.db.transaction(async (tx) => {
      // Serialise assignments. Without this, two workers processing two clips of
      // the same fire at the same moment could both see "no incident yet" and
      // create two. A transaction-scoped advisory lock is released on commit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('micky:assign-incident'))`);

      const item = await tx.query.media.findFirst({ where: eq(media.id, mediaId) });
      if (!item) throw new NotFoundException(`Media ${mediaId} not found`);
      if (item.incidentId) return item.incidentId; // already assigned: retries are harmless

      const windowMs = CLUSTER_WINDOW_HOURS * 3_600_000;
      const cells = [item.geohash, ...ngeohash.neighbors(item.geohash)];
      const candidates = await tx
        .select({ id: incidents.id, category: incidents.category })
        .from(incidents)
        .where(
          and(
            inArray(incidents.geohash, cells),
            // capturedAt within [firstSeenAt − 2 h, lastSeenAt + 2 h]
            lte(incidents.firstSeenAt, new Date(item.capturedAt.getTime() + windowMs)),
            gte(incidents.lastSeenAt, new Date(item.capturedAt.getTime() - windowMs)),
          ),
        )
        .orderBy(desc(incidents.lastSeenAt));

      // Prefer an incident of the same category (a fire and a road accident on
      // the same street are different stories); otherwise take the most recent.
      const match = candidates.find((c) => c.category === item.category) ?? candidates[0];

      let id: string;
      if (match) {
        id = match.id;
        // Stretch the incident's time span so later uploads can still join it.
        await tx
          .update(incidents)
          .set({
            firstSeenAt: sql`LEAST(${incidents.firstSeenAt}, ${item.capturedAt})`,
            lastSeenAt: sql`GREATEST(${incidents.lastSeenAt}, ${item.capturedAt})`,
          })
          .where(eq(incidents.id, id));
      } else {
        const [created] = await tx
          .insert(incidents)
          .values({
            title: incidentTitle(item),
            category: item.category,
            geohash: item.geohash,
            // Never the witness's exact point: incidents are shown to every newsroom.
            latitude: publicCoordinate(item.latitude),
            longitude: publicCoordinate(item.longitude),
            locationName: item.locationName,
            firstSeenAt: item.capturedAt,
            lastSeenAt: item.capturedAt,
          })
          .returning({ id: incidents.id });
        id = created.id;
      }

      await tx.update(media).set({ incidentId: id }).where(eq(media.id, mediaId));
      return id;
    });

    await this.recompute(incidentId);
    return incidentId;
  }

  /**
   * Recomputes mediaCount, uploaderCount (APPROVED media only), lastSeenAt and
   * trendScore of one incident. Call after a media item is approved, rejected or removed.
   */
  async recompute(incidentId: string): Promise<void> {
    const incident = await this.db.query.incidents.findFirst({ where: eq(incidents.id, incidentId) });
    if (!incident) throw new NotFoundException(`Incident ${incidentId} not found`);

    // Counters come from APPROVED media only: channels must not see a "5 uploads"
    // incident that has nothing they can actually view or buy.
    const [approved] = await this.db
      .select({
        mediaCount: sql<number>`count(*)::int`,
        uploaderCount: sql<number>`count(DISTINCT ${media.uploaderId})::int`,
        mediaViews: sql<number>`coalesce(sum(${media.viewCount}), 0)::int`,
        verificationBonus: sql<number>`count(*) FILTER (WHERE ${verifications.c2paStatus} = 'valid')::int`,
      })
      .from(media)
      .leftJoin(verifications, eq(verifications.mediaId, media.id))
      .where(and(eq(media.incidentId, incidentId), eq(media.status, 'APPROVED')));

    // The time span covers every live upload (also those still in review), so
    // clustering keeps working before an admin has approved anything.
    const [span] = await this.db
      .select({
        first: sql<string | null>`min(${media.capturedAt})`,
        last: sql<string | null>`max(${media.capturedAt})`,
      })
      .from(media)
      .where(and(eq(media.incidentId, incidentId), inArray(media.status, [...LIVE_STATUSES])));

    const firstSeenAt = span.first ? new Date(span.first) : incident.firstSeenAt;
    const lastSeenAt = span.last ? new Date(span.last) : incident.lastSeenAt;
    const score = trendScore({
      uploaderCount: approved.uploaderCount,
      mediaCount: approved.mediaCount,
      // Views of the incident page plus views of its approved media.
      viewCount: incident.viewCount + approved.mediaViews,
      verificationBonus: approved.verificationBonus,
      firstSeenAt,
      now: new Date(),
    });

    await this.db
      .update(incidents)
      .set({
        mediaCount: approved.mediaCount,
        uploaderCount: approved.uploaderCount,
        firstSeenAt,
        lastSeenAt,
        trendScore: score,
      })
      .where(eq(incidents.id, incidentId));

    if (approved.mediaCount > 0) {
      this.realtime?.emitToChannels({
        type: 'incident.updated',
        incidentId,
        trendScore: score,
        mediaCount: approved.mediaCount,
      });
    }
  }

  /** Recomputes trend scores of all incidents active in the last 72 hours (scheduled job). */
  async recomputeActive(): Promise<number> {
    const since = new Date(Date.now() - ACTIVE_HOURS * 3_600_000);
    const active = await this.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(gte(incidents.lastSeenAt, since))
      .orderBy(asc(incidents.lastSeenAt));

    for (const { id } of active) {
      await this.recompute(id);
    }
    this.logger.log(`Recomputed ${active.length} active incident(s)`);
    return active.length;
  }
}

/** "Fire near Gandhipuram" when we know the place name, otherwise the first upload's title. */
function incidentTitle(item: { category: Category; locationName: string | null; title: string }): string {
  return item.locationName ? `${CATEGORY_LABEL[item.category]} near ${item.locationName}` : item.title;
}
