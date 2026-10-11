import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';

/** Events pushed to connected news-channel dashboards. */
export type RealtimeEvent =
  | { type: 'media.approved'; mediaId: string; incidentId: string | null; title: string; category: string }
  | { type: 'incident.updated'; incidentId: string; trendScore: number; mediaCount: number };

/** Socket.IO room that every approved channel and admin joins on connection. */
export const CHANNELS_ROOM = 'channels';

/**
 * CONTRACT (owned by the market/realtime builder).
 * Other modules call `emitToChannels` after state changes. Keep the signature stable.
 *
 * The service does not own the socket server: the gateway attaches its namespace
 * once Socket.IO has started (`attach`). Until then, and in processes without a
 * gateway (the worker), events are simply dropped with a debug log, so callers
 * never have to care whether anyone is listening.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private namespace: Namespace | null = null;

  /** Called by LiveGateway after Socket.IO is initialised. */
  attach(namespace: Namespace): void {
    this.namespace = namespace;
  }

  /** Sends an event to every connected, approved news channel (and admins). */
  emitToChannels(event: RealtimeEvent): void {
    if (!this.namespace) {
      this.logger.debug(`No realtime gateway; dropped ${event.type}`);
      return;
    }
    // The event name travels separately, so the payload is everything except `type`.
    const { type, ...payload } = event;
    try {
      this.namespace.to(CHANNELS_ROOM).emit(type, payload);
    } catch (err) {
      // A notification failing must never break the action that triggered it (e.g. an approval).
      this.logger.warn(`Could not emit ${type}: ${(err as Error).message}`);
    }
  }
}
