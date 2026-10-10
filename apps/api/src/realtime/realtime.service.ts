import { Injectable, Logger } from '@nestjs/common';

/** Events pushed to connected news-channel dashboards. */
export type RealtimeEvent =
  | { type: 'media.approved'; mediaId: string; incidentId: string | null; title: string; category: string }
  | { type: 'incident.updated'; incidentId: string; trendScore: number; mediaCount: number };

/**
 * CONTRACT (owned by the market/realtime builder).
 * Other modules call `emitToChannels` after state changes; the realtime builder
 * connects it to the Socket.IO gateway. Keep the signature stable.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  /** Sends an event to every connected, approved news channel (and admins). */
  emitToChannels(event: RealtimeEvent): void {
    this.logger.debug(`(no gateway yet) ${event.type}`);
  }
}
