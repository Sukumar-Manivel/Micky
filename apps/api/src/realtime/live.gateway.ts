import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { eq } from 'drizzle-orm';
import type { Namespace, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../common/auth.guards.js';
import { AppConfig } from '../config/app-config.js';
import { type Database, InjectDb } from '../db/db.module.js';
import { channelProfiles, users } from '../db/schema.js';
import { CHANNELS_ROOM, RealtimeService } from './realtime.service.js';

/**
 * Socket.IO CORS options are fixed when the decorator runs (at import time),
 * before AppConfig exists. So the decorator gets a callback that reads the
 * allowed origins from here, and the gateway fills them in when it is created.
 */
let allowedOrigins: readonly string[] = [];

/**
 * Live updates for news-channel dashboards, on the Socket.IO namespace "/live".
 *
 * The browser connects with `io(apiUrl + '/live', { auth: { token: accessToken } })`.
 * The access token travels in the handshake (not in the URL, so it doesn't end
 * up in proxy logs). Approved channels and admins join the "channels" room and
 * receive broadcasts from RealtimeService; everyone else gets an `error` event
 * and is disconnected.
 */
@WebSocketGateway({
  namespace: '/live',
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      // No Origin header = not a browser (server-to-server, tests); the token still protects it.
      callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  },
})
export class LiveGateway implements OnGatewayInit<Namespace>, OnGatewayConnection<Socket> {
  private readonly logger = new Logger(LiveGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
    @InjectDb() private readonly db: Database,
  ) {
    allowedOrigins = config.corsOrigins;
  }

  /** Socket.IO is ready: hand the namespace to the service other modules call. */
  afterInit(namespace: Namespace): void {
    this.realtime.attach(namespace);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token: unknown = client.handshake.auth?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return this.reject(client, 'Missing access token');
      }

      let payload: AccessTokenPayload & { exp?: number };
      try {
        payload = await this.jwt.verifyAsync(token, { secret: this.config.jwtAccessSecret });
      } catch {
        return this.reject(client, 'Invalid or expired access token');
      }

      // Read the role and approval from the database, not just the token:
      // a channel may have been approved or rejected since the token was issued.
      const [account] = await this.db
        .select({ role: users.role, channelStatus: channelProfiles.status })
        .from(users)
        .leftJoin(channelProfiles, eq(channelProfiles.userId, users.id))
        .where(eq(users.id, payload.sub))
        .limit(1);
      const allowed =
        account?.role === 'ADMIN' || (account?.role === 'CHANNEL' && account.channelStatus === 'APPROVED');
      if (!allowed) {
        return this.reject(client, 'Only approved news organisations can receive live updates');
      }

      await client.join(CHANNELS_ROOM);
      this.disconnectWhenTokenExpires(client, payload.exp);
    } catch (err) {
      this.logger.error(`Live connection failed: ${(err as Error).message}`);
      this.reject(client, 'Could not connect to live updates');
    }
  }

  private reject(client: Socket, message: string): void {
    client.emit('error', { message });
    client.disconnect(true);
  }

  /**
   * A socket outlives the 15-minute access token that opened it. Closing it when
   * the token expires makes the client reconnect with a fresh token, so a
   * revoked or downgraded account cannot keep listening forever.
   */
  private disconnectWhenTokenExpires(client: Socket, exp: number | undefined): void {
    if (!exp) return;
    const ms = exp * 1000 - Date.now();
    const timer = setTimeout(
      () => {
        client.emit('error', { message: 'Access token expired; reconnect with a new token' });
        client.disconnect(true);
      },
      Math.max(0, ms),
    );
    timer.unref(); // never keep the process alive just for this
    client.once('disconnect', () => clearTimeout(timer));
  }
}
