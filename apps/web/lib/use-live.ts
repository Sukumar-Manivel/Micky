'use client';

// Live alerts over Socket.IO.
//
// The server pushes 'media.approved' and 'incident.updated' to approved newsrooms on the
// `/live` namespace. Socket.IO uses a WebSocket when it can and falls back to HTTP long-polling
// on networks that block WebSockets, and it reconnects by itself.
//
// Authentication: the access token is sent in the handshake `auth` payload. Because tokens
// expire every 15 minutes, `auth` is a callback, so each reconnect fetches the *current*
// token. If the server rejects us (expired token), we refresh the session and reconnect.

import { useEffect, useEffectEvent, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { session } from './api';
import { API_URL } from './config';
import type { IncidentUpdatedEvent, MediaApprovedEvent } from './types';

export type LiveStatus = 'connecting' | 'live' | 'offline';

interface Handlers {
  onMediaApproved?: (e: MediaApprovedEvent) => void;
  onIncidentUpdated?: (e: IncidentUpdatedEvent) => void;
}

export function useLive(enabled: boolean, handlers: Handlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const onMediaApproved = useEffectEvent((e: MediaApprovedEvent) => handlers.onMediaApproved?.(e));
  const onIncidentUpdated = useEffectEvent((e: IncidentUpdatedEvent) => handlers.onIncidentUpdated?.(e));

  useEffect(() => {
    if (!enabled) return;
    let socket: Socket | null = null;
    let disposed = false;
    let authRetries = 0;

    (async () => {
      // Load the client library only on pages that use live alerts.
      const { io } = await import('socket.io-client');
      if (disposed) return;
      socket = io(`${API_URL}/live`, {
        path: '/socket.io',
        auth: (cb) => cb({ token: session.getToken() }),
        withCredentials: true,
      });
      socket.on('connect', () => {
        authRetries = 0;
        setStatus('live');
      });
      socket.on('disconnect', () => setStatus('offline'));
      socket.on('connect_error', () => setStatus('offline'));
      // The server emits 'error' and disconnects when the token is invalid or the user is not allowed.
      socket.on('error', async () => {
        if (authRetries++ >= 2) return;
        const token = await session.refresh();
        if (token && !disposed) socket?.connect();
      });
      socket.on('media.approved', onMediaApproved);
      socket.on('incident.updated', onIncidentUpdated);
    })();

    return () => {
      disposed = true;
      socket?.disconnect();
    };
  }, [enabled]);

  return enabled ? status : 'offline';
}
