import { useSyncExternalStore } from 'react';

import type { ClientMessage, ServerEvent } from '../../../server/src/realtime/protocol';
import { base64ToBytes } from '@/infrastructure/crypto/base64';
import { API_BASE_URL, getAccessTokenForRequest, refreshAccessTokenOnce } from '@/infrastructure/network/trpcClient';

export type RealtimeEvent = ServerEvent;
export type RealtimeMessage = ClientMessage;
export type RealtimeStatus = 'offline' | 'connecting' | 'online';

const PING_INTERVAL_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUED_MESSAGES = 100;
/** A token expiring within this window is refreshed before connecting instead of being rejected by the server. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Close codes sent by the server (server/src/http/realtime.ts).
const CLOSE_REPLACED = 4000;
const CLOSE_TOKEN_EXPIRED = 4001;
const CLOSE_SESSION_REVOKED = 4003;
const CLOSE_POLICY_VIOLATION = 1008;

/** React Native's WebSocket accepts request headers as a third argument; the DOM typings in scope don't know that. */
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string | string[] | undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

function tokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const exp = (JSON.parse(String.fromCharCode(...base64ToBytes(base64))) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The app's one authenticated WebSocket to the server (`/realtime`): call
 * signaling and content-free "conversation updated" hints. While wanted, it
 * reconnects with exponential backoff and refreshes the access token when
 * the server closes the socket because the token expired. Messages sent
 * while disconnected are queued (bounded) and flushed on reconnect, so a
 * brief network switch mid-call doesn't lose signaling.
 */
class RealtimeClient {
  private socket: WebSocket | null = null;
  private status: RealtimeStatus = 'offline';
  private readonly eventListeners = new Set<(event: RealtimeEvent) => void>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private readonly queue: RealtimeMessage[] = [];
  private wanted = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  getStatus = (): RealtimeStatus => this.status;

  /** Connects, or stays connected. Idempotent. */
  start(): void {
    this.wanted = true;
    if (!this.socket && !this.retryTimer) void this.connect();
  }

  /** Disconnects and stops reconnecting; queued messages are dropped. */
  stop(): void {
    this.wanted = false;
    this.clearRetry();
    this.stopPing();
    this.queue.length = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client stopped');
    this.setStatus('offline');
  }

  /** Sends now when connected; otherwise queues until the next connection. */
  send(message: RealtimeMessage): void {
    if (this.socket && this.status === 'online') {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (this.queue.length < MAX_QUEUED_MESSAGES) this.queue.push(message);
    if (this.wanted && !this.socket && !this.retryTimer) void this.connect();
  }

  onEvent(listener: (event: RealtimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus = (listener: (status: RealtimeStatus) => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  private setStatus(next: RealtimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.statusListeners]) listener(next);
  }

  private async connect(): Promise<void> {
    this.clearRetry();
    let token = getAccessTokenForRequest();
    const expiresAt = token ? tokenExpiresAt(token) : null;
    if (token && expiresAt !== null && expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      this.setStatus('connecting');
      await refreshAccessTokenOnce();
      token = getAccessTokenForRequest();
    }
    if (!this.wanted || this.socket) return;
    if (!token) {
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }

    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new HeaderWebSocket(`${API_BASE_URL.replace(/^http/, 'ws')}/realtime`, undefined, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      this.setStatus('offline');
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setStatus('online');
      this.startPing();
      for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message));
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      let parsed: RealtimeEvent;
      try {
        parsed = JSON.parse(event.data) as RealtimeEvent;
      } catch {
        return;
      }
      for (const listener of [...this.eventListeners]) {
        try {
          listener(parsed);
        } catch {
          // One listener's failure must not stop the others.
        }
      }
    };

    // Always followed by onclose, which decides what happens next.
    socket.onerror = () => {};

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.setStatus('offline');
      if (!this.wanted) return;
      if (event.code === CLOSE_REPLACED) {
        // A newer connection from this same device took over; don't fight it.
        return;
      }
      if (event.code === CLOSE_SESSION_REVOKED) {
        // This session was terminated on the server. Don't reconnect blindly:
        // a refresh fails for a terminated session, which signs the app out
        // (AuthContext); only a session that is somehow still valid reconnects.
        void refreshAccessTokenOnce().then((refreshed) => {
          if (refreshed && this.wanted && !this.socket) void this.connect();
        });
        return;
      }
      if (event.code === CLOSE_TOKEN_EXPIRED || event.code === CLOSE_POLICY_VIOLATION) {
        void refreshAccessTokenOnce().then(() => {
          if (this.wanted && !this.socket) void this.connect();
        });
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted && !this.socket) void this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.socket && this.status === 'online') this.socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const realtime = new RealtimeClient();

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(realtime.onStatus, realtime.getStatus);
}
