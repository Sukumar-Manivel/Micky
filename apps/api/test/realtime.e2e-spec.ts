// Realtime gateway tests against a real listening server.
//
// socket.io-client is not a dependency, so this file includes a tiny client
// that speaks the Socket.IO wire protocol over Node's built-in WebSocket:
//   Engine.IO packets: "0" open, "2" ping, "3" pong, "4" message
//   Socket.IO packets (inside "4"): "0" connect, "1" disconnect, "2" event
//   e.g. "40/live,{...auth}" connects to namespace /live,
//        '42/live,["media.approved",{...}]' is an event on /live.
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { channelProfiles } from '../src/db/schema.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
import { db, resetDb, startApp } from './helpers.js';
import { accessTokenFor, approvedChannel, createUser } from './market.fixtures.js';

type Received = { event: string; data: unknown };

/** Minimal Socket.IO client for one namespace. */
class TestSocket {
  readonly events: Received[] = [];
  connected = false;
  closed = false;
  private readonly ws: WebSocket;
  private waiters: Array<() => void> = [];

  constructor(port: number, auth: Record<string, unknown>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    this.ws.onmessage = (msg) => this.onPacket(String(msg.data), auth);
    this.ws.onclose = () => {
      this.closed = true;
      this.notify();
    };
  }

  private onPacket(packet: string, auth: Record<string, unknown>) {
    if (packet.startsWith('0'))
      this.ws.send(`40/live,${JSON.stringify(auth)}`); // engine open -> join namespace
    else if (packet === '2')
      this.ws.send('3'); // ping -> pong
    else if (packet.startsWith('40/live,')) this.connected = true;
    else if (packet.startsWith('41/live'))
      this.connected = false; // server disconnected us from the namespace
    else if (packet.startsWith('42/live,')) {
      const [event, data] = JSON.parse(packet.slice('42/live,'.length)) as [string, unknown];
      this.events.push({ event, data });
    }
    this.notify();
  }

  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  /** Waits until `predicate` is true (checked after every packet), or fails after `ms`. */
  async until(predicate: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for socket state');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  close() {
    this.ws.close();
  }
}

describe('Realtime gateway (e2e)', () => {
  let app: NestExpressApplication;
  let port: number;
  const sockets: TestSocket[] = [];
  const connect = (auth: Record<string, unknown>) => {
    const socket = new TestSocket(port, auth);
    sockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    app = await startApp();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterEach(() => {
    sockets.splice(0).forEach((s) => s.close());
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets approved channels and admins join, and delivers events without the type field', async () => {
    const channel = await approvedChannel(app);
    const admin = await createUser(app, 'ADMIN');
    const channelSocket = connect({ token: channel.accessToken });
    const adminSocket = connect({ token: admin.accessToken });
    await channelSocket.until(() => channelSocket.connected);
    await adminSocket.until(() => adminSocket.connected);

    // The room is joined asynchronously after the namespace connect; wait for it.
    await new Promise((r) => setTimeout(r, 100));
    app.get(RealtimeService).emitToChannels({
      type: 'media.approved',
      mediaId: 'm1',
      incidentId: null,
      title: 'Fire',
      category: 'FIRE',
    });
    app
      .get(RealtimeService)
      .emitToChannels({ type: 'incident.updated', incidentId: 'i1', trendScore: 4.2, mediaCount: 3 });

    for (const socket of [channelSocket, adminSocket]) {
      await socket.until(() => socket.events.length >= 2);
      expect(socket.events).toEqual([
        { event: 'media.approved', data: { mediaId: 'm1', incidentId: null, title: 'Fire', category: 'FIRE' } },
        { event: 'incident.updated', data: { incidentId: 'i1', trendScore: 4.2, mediaCount: 3 } },
      ]);
    }
  });

  it('allows CORS only from the configured web origins', async () => {
    const handshake = (origin: string) =>
      fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: origin } });
    const allowed = await handshake('http://localhost:3000'); // default CORS_ORIGINS = WEB_URL
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const denied = await handshake('https://evil.example');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects missing, invalid and expired tokens with an error event', async () => {
    const channel = await approvedChannel(app);
    const expired = await accessTokenFor(app, channel.user, -10);

    for (const auth of [{}, { token: 'not-a-jwt' }, { token: expired }, { token: 123 }]) {
      const socket = connect(auth);
      await socket.until(() => socket.events.some((e) => e.event === 'error'));
      await socket.until(() => !socket.connected || socket.closed);
      expect(socket.events[0].data).toHaveProperty('message');
    }
  });

  it('rejects uploaders and channels that are not approved, and they receive no broadcasts', async () => {
    const uploader = await createUser(app, 'UPLOADER');
    const pending = await createUser(app, 'CHANNEL');
    const approved = await approvedChannel(app);
    // Approved when the token was issued, rejected since: the database decides, not the token.
    await db(app)
      .update(channelProfiles)
      .set({ status: 'REJECTED' })
      .where(eq(channelProfiles.userId, approved.user.id));

    for (const token of [uploader.accessToken, pending.accessToken, approved.accessToken]) {
      const socket = connect({ token });
      await socket.until(() => socket.events.some((e) => e.event === 'error'));
      expect(socket.events[0].data).toEqual({ message: 'Only approved news organisations can receive live updates' });
      await socket.until(() => !socket.connected || socket.closed);

      app
        .get(RealtimeService)
        .emitToChannels({ type: 'incident.updated', incidentId: 'x', trendScore: 1, mediaCount: 1 });
      await new Promise((r) => setTimeout(r, 100));
      expect(socket.events.map((e) => e.event)).toEqual(['error']);
    }
  });
});
