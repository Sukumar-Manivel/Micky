import { Injectable, NotImplementedException } from '@nestjs/common';
import { type Database, InjectDb } from '../db/db.module.js';

/**
 * CONTRACT (owned by the media/processing builder).
 * Groups media into incidents and keeps incident counters and trend scores fresh.
 * Other modules (admin, market) call these methods; keep the signatures stable.
 */
@Injectable()
export class IncidentsService {
  constructor(@InjectDb() private readonly db: Database) {}

  /**
   * Attaches a processed media item to an existing nearby incident
   * (same or neighbouring geohash-6 cell, captured within the clustering window),
   * or creates a new incident. Returns the incident id.
   */
  async assignIncident(mediaId: string): Promise<string> {
    void mediaId;
    throw new NotImplementedException();
  }

  /**
   * Recomputes mediaCount, uploaderCount (APPROVED media only), lastSeenAt and
   * trendScore of one incident. Call after a media item is approved, rejected or removed.
   */
  async recompute(incidentId: string): Promise<void> {
    void incidentId;
    throw new NotImplementedException();
  }

  /** Recomputes trend scores of all incidents active in the last 72 hours (scheduled job). */
  async recomputeActive(): Promise<number> {
    throw new NotImplementedException();
  }
}
