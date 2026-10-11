import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { AuthUser } from '../common/auth.decorators.js';
import { offsetOf, type Paginated, paginated } from '../common/pagination.js';
import { UrlService } from '../common/urls.service.js';
import { type MediaMarketView, PUBLIC_COORDINATE_DECIMALS, publicCoordinate, toMediaMarketView } from '../common/views.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { incidents, media, orders, verifications } from '../db/schema.js';
import { escapeLike, publicCoordinateSql, withinRadius } from './geo.js';
import { DEFAULT_RADIUS_KM, type MarketIncidentsQuery, type MarketMediaQuery } from './market.dto.js';

type MediaRow = typeof media.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;

/** Shape of an incident in the marketplace (docs/API.md, IncidentView). */
export interface IncidentView {
  id: string;
  title: string;
  category: IncidentRow['category'];
  latitude: number;
  longitude: number;
  locationName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mediaCount: number;
  uploaderCount: number;
  trendScore: number;
  thumbnailUrl: string | null;
}

/** An incident page lists at most this many media items (newest first). */
const INCIDENT_MEDIA_LIMIT = 100;

/** "Published" = when an admin approved it (falls back to upload time). Matches toMediaMarketView. */
const publishedAt = sql`coalesce(${media.reviewedAt}, ${media.createdAt})`;

/**
 * Read side of the marketplace: what approved news channels (and admins) can browse.
 *
 * Every list follows the same pattern, to avoid N+1 queries:
 *   1 query for the page of rows + 1 for the total,
 *   then 1 query per kind of related data for ALL rows of the page at once
 *   (verifications, paid-order counts, the caller's own purchases).
 * So a page costs 5 queries whether it has 1 item or 100.
 */
@Injectable()
export class MarketService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly urls: UrlService,
  ) {}

  // ---------- Media ----------

  async listMedia(user: AuthUser, query: MarketMediaQuery): Promise<Paginated<MediaMarketView>> {
    const point = readPoint(query.lat, query.lng);
    if (query.sort === 'nearest' && !point) {
      throw new BadRequestException('sort=nearest needs lat and lng');
    }
    if (query.radiusKm !== undefined && !point) {
      throw new BadRequestException('radiusKm needs lat and lng');
    }

    const conditions: (SQL | undefined)[] = [eq(media.status, 'APPROVED')];
    if (query.category) conditions.push(eq(media.category, query.category));
    if (query.type) conditions.push(eq(media.type, query.type));
    if (query.sinceHours) {
      // "In the last N hours" refers to when the event was filmed.
      conditions.push(gte(media.capturedAt, hoursAgo(query.sinceHours)));
    }
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      conditions.push(
        or(ilike(media.title, pattern), ilike(media.description, pattern), ilike(media.locationName, pattern)),
      );
    }

    let distance: SQL<number> | undefined;
    if (point) {
      const radius = withinRadius(
        publicCoordinateSql(media.latitude, PUBLIC_COORDINATE_DECIMALS),
        publicCoordinateSql(media.longitude, PUBLIC_COORDINATE_DECIMALS),
        point.lat,
        point.lng,
        query.radiusKm ?? DEFAULT_RADIUS_KM,
      );
      conditions.push(radius.where);
      distance = radius.distance;
    }
    const where = and(...conditions);

    // Sorting. Every order ends with the id so pages are stable when values tie.
    const orderBy: SQL[] = [];
    if (query.sort === 'nearest') orderBy.push(sql`${distance} asc`);
    if (query.sort === 'trending') orderBy.push(sql`coalesce(${incidents.trendScore}, 0) desc`);
    orderBy.push(sql`${publishedAt} desc`, desc(media.id));

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({ media, distance: distance ?? sql<null>`null` })
        .from(media)
        // The join is only needed for the trending sort; it is a primary-key lookup.
        .leftJoin(incidents, eq(incidents.id, media.incidentId))
        .where(where)
        .orderBy(...orderBy)
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(media).where(where),
    ]);

    const items = await this.toMarketViews(
      user,
      rows.map((r) => r.media),
      new Map(rows.map((r) => [r.media.id, r.distance === null ? undefined : Number(r.distance)])),
    );
    return paginated(items, total, query);
  }

  /**
   * One media item. Channels see APPROVED media only; admins see any status.
   * A channel's view is counted on the media and on its incident (it feeds the
   * trending score), using `view_count = view_count + 1` so concurrent requests
   * never lose an increment.
   */
  async getMedia(user: AuthUser, id: string): Promise<MediaMarketView> {
    const isAdmin = user.role === 'ADMIN';
    let row: MediaRow | undefined;

    if (isAdmin) {
      // Admin views are moderation, not market interest: don't count them.
      row = await this.db.query.media.findFirst({ where: eq(media.id, id) });
    } else {
      // Read and increment in a single atomic statement.
      [row] = await this.db
        .update(media)
        // updatedAt is kept as is: a view is not an edit (Drizzle's $onUpdate would bump it otherwise).
        .set({ viewCount: sql`${media.viewCount} + 1`, updatedAt: sql`${media.updatedAt}` })
        .where(and(eq(media.id, id), eq(media.status, 'APPROVED')))
        .returning();
      if (row?.incidentId) {
        await this.db
          .update(incidents)
          .set({ viewCount: sql`${incidents.viewCount} + 1`, updatedAt: sql`${incidents.updatedAt}` })
          .where(eq(incidents.id, row.incidentId));
      }
    }
    if (!row) throw new NotFoundException('Media not found');

    const [view] = await this.toMarketViews(user, [row]);
    return view;
  }

  // ---------- Incidents ----------

  /** Every approved channel sees the same incidents, so this needs no caller. */
  async listIncidents(query: MarketIncidentsQuery): Promise<Paginated<IncidentView>> {
    const point = readPoint(query.lat, query.lng);
    if (query.radiusKm !== undefined && !point) {
      throw new BadRequestException('radiusKm needs lat and lng');
    }

    const conditions: (SQL | undefined)[] = [
      sql`${incidents.mediaCount} > 0`,
      gte(incidents.lastSeenAt, hoursAgo(query.sinceHours)),
    ];
    if (query.category) conditions.push(eq(incidents.category, query.category));
    if (point) {
      conditions.push(
        withinRadius(
          publicCoordinateSql(incidents.latitude, PUBLIC_COORDINATE_DECIMALS),
          publicCoordinateSql(incidents.longitude, PUBLIC_COORDINATE_DECIMALS),
          point.lat,
          point.lng,
          query.radiusKm ?? DEFAULT_RADIUS_KM,
        ).where,
      );
    }
    const where = and(...conditions);
    const orderBy =
      query.sort === 'trending'
        ? [desc(incidents.trendScore), desc(incidents.lastSeenAt), desc(incidents.id)]
        : [desc(incidents.lastSeenAt), desc(incidents.id)];

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(incidents)
        .where(where)
        .orderBy(...orderBy)
        .limit(query.pageSize)
        .offset(offsetOf(query)),
      this.db.select({ total: count() }).from(incidents).where(where),
    ]);

    const thumbs = await this.newestThumbnails(rows.map((r) => r.id));
    return paginated(
      rows.map((r) => this.toIncidentView(r, thumbs.get(r.id) ?? null)),
      total,
      query,
    );
  }

  async getIncident(user: AuthUser, id: string): Promise<IncidentView & { media: MediaMarketView[] }> {
    const incident = await this.db.query.incidents.findFirst({
      where: and(eq(incidents.id, id), sql`${incidents.mediaCount} > 0`),
    });
    if (!incident) throw new NotFoundException('Incident not found');

    const rows = await this.db
      .select()
      .from(media)
      .where(and(eq(media.incidentId, id), eq(media.status, 'APPROVED')))
      .orderBy(sql`${publishedAt} desc`, desc(media.id))
      .limit(INCIDENT_MEDIA_LIMIT);

    const items = await this.toMarketViews(user, rows);
    const newestWithThumb = rows.find((r) => r.thumbKey);
    return {
      ...this.toIncidentView(incident, newestWithThumb ? this.urls.thumbnailUrl(newestWithThumb) : null),
      media: items,
    };
  }

  // ---------- Mapping helpers ----------

  /**
   * Maps media rows to MediaMarketView, loading related data for all rows in
   * three batched queries (never one query per row).
   */
  private async toMarketViews(
    user: AuthUser,
    rows: MediaRow[],
    distances?: Map<string, number | undefined>,
  ): Promise<MediaMarketView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [verificationRows, paidCounts, ownPaid] = await Promise.all([
      this.db.select().from(verifications).where(inArray(verifications.mediaId, ids)),
      this.db
        .select({ mediaId: orders.mediaId, n: count() })
        .from(orders)
        .where(and(inArray(orders.mediaId, ids), eq(orders.status, 'PAID')))
        .groupBy(orders.mediaId),
      this.db
        .select({ id: orders.id, mediaId: orders.mediaId, licenseType: orders.licenseType })
        .from(orders)
        .where(and(inArray(orders.mediaId, ids), eq(orders.buyerId, user.id), eq(orders.status, 'PAID'))),
    ]);

    const verificationByMedia = new Map(verificationRows.map((v) => [v.mediaId, v]));
    const paidCountByMedia = new Map(paidCounts.map((c) => [c.mediaId, c.n]));
    const purchasedByMedia = new Map<string, { orderId: string; licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' }>();
    for (const o of ownPaid) {
      // A channel buys each media at most once; if it ever had two, show the exclusive one.
      const existing = purchasedByMedia.get(o.mediaId);
      if (!existing || o.licenseType === 'EXCLUSIVE') {
        purchasedByMedia.set(o.mediaId, { orderId: o.id, licenseType: o.licenseType });
      }
    }

    return rows.map((row) =>
      toMediaMarketView(row, {
        urls: this.urls,
        verification: verificationByMedia.get(row.id) ?? null,
        paidOrderCount: paidCountByMedia.get(row.id) ?? 0,
        purchased: purchasedByMedia.get(row.id) ?? null,
        includeMetadata: user.role === 'ADMIN',
        // Exact point: admins only. Buyers too get the rounded point (no uploader opt-in yet).
        exactLocation: user.role === 'ADMIN',
        distanceKm: distances?.get(row.id),
      }),
    );
  }

  /**
   * Thumbnail URL of the newest approved media (that has a thumbnail) of each
   * incident, in one query using Postgres's DISTINCT ON.
   */
  private async newestThumbnails(incidentIds: string[]): Promise<Map<string, string | null>> {
    if (incidentIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([media.incidentId], { incidentId: media.incidentId, id: media.id, thumbKey: media.thumbKey })
      .from(media)
      .where(and(inArray(media.incidentId, incidentIds), eq(media.status, 'APPROVED'), isNotNull(media.thumbKey)))
      .orderBy(media.incidentId, sql`${publishedAt} desc`);
    return new Map(rows.map((r) => [r.incidentId!, this.urls.thumbnailUrl(r)]));
  }

  private toIncidentView(row: IncidentRow, thumbnailUrl: string | null): IncidentView {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      // Incidents start at their first upload's point: rounded like media (review M8).
      latitude: publicCoordinate(row.latitude),
      longitude: publicCoordinate(row.longitude),
      locationName: row.locationName,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      mediaCount: row.mediaCount,
      uploaderCount: row.uploaderCount,
      trendScore: row.trendScore,
      thumbnailUrl,
    };
  }
}

/** lat and lng must be given together; returns the point, or null when neither is given. */
function readPoint(lat?: number, lng?: number): { lat: number; lng: number } | null {
  if (lat === undefined && lng === undefined) return null;
  if (lat === undefined || lng === undefined) throw new BadRequestException('lat and lng must be given together');
  return { lat, lng };
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3600 * 1000);
}
