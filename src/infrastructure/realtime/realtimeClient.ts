import { useSyncExternalStore } from 'react';

import type { ClientMessage, ServerEvent } from '../../../server/src/realtime/protocol';
import { base64ToBytes } from '@/infrastructure/crypto/base64';
import { API_BASE_URL, getAccessTokenForRequest, refreshAccessTokenOnce } from '@/infrastructure/network/trpcClient';

export type RealtimeEvent = ServerEvent;
export type RealtimeMessage = ClientMessage;
export type RealtimeStatus = 'offline' | 'connecting' | 'online';

const PING_INTERVAL_MS = 20_000;
/**
 * A socket not open after this long is dropped and retried. React Native's
 * WebSocket (OkHttp, WebSocketModule) bounds only the TCP connect, not the
 * upgrade response, so a handshake that is never answered used to leave the
 * socket "connecting" — and realtime (calls, chat hints) dead — for good.
 */
const CONNECT_TIMEOUT_MS = 15_000;
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
  /**
   * True from the start of connect() until it has either created a socket
   * or given up. connect() awaits a token refresh before it assigns
   * `socket`, and start()/send()/retries all call it — without this, two
   * overlapping calls opened two sockets for one device. The server then
   * closes one as "replaced"; when that was the tracked one, this client
   * stopped reconnecting while ignoring the other's events, leaving
   * realtime (chat hints, call signaling) dead until the app restarted.
   */
  private connecting = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Nothing has arrived since the last ping was sent. */
  private awaitingPong = false;
  /** Abandoned sockets not closed yet (see abandon). */
  private strays = 0;

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
    this.clearConnectTimer();
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
    if (this.connecting || this.socket) return;
    this.connecting = true;
    try {
      await this.openSocket();
    } finally {
      this.connecting = false;
    }
  }

  private async openSocket(): Promise<void> {
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
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket === socket && this.status !== 'online') this.abandon(socket);
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.attempts = 0;
      this.setStatus('online');
      this.startPing();
      for (const message of this.queue.splice(0)) socket.send(JSON.stringify(message));
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      this.awaitingPong = false;
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
      this.clearConnectTimer();
      this.stopPing();
      this.setStatus('offline');
      if (!this.wanted) return;
      if (event.code === CLOSE_REPLACED) {
        // A newer connection from this same device took over; don't fight it
        // — unless that newer connection may be one of our own abandoned
        // sockets finishing its handshake late (it closes itself on open, see
        // abandon), which would otherwise leave this device with none.
        if (this.strays > 0) this.scheduleRetry();
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

  /**
   * Gives up on a socket that is stuck connecting or has gone silent, and
   * reconnects. React Native ignores close() on a socket that is still
   * connecting, so an abandoned handshake can still complete later — and the
   * server then closes our current connection as replaced by it. Until its
   * own onclose, such a socket counts as a stray: it shuts itself as soon as
   * it opens, and a "replaced" close meanwhile reconnects (see onclose).
   */
  private abandon(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearConnectTimer();
    this.stopPing();
    this.strays += 1;
    socket.onmessage = null;
    socket.onopen = () => {
      try {
        socket.close(1000, 'abandoned');
      } catch {
        // already closing
      }
    };
    socket.onclose = () => {
      this.strays -= 1;
    };
    try {
      socket.close();
    } catch {
      // already closing
    }
    this.setStatus('offline');
    this.scheduleRetry();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /**
   * Pings every PING_INTERVAL_MS; the server answers each with a pong. A
   * connection that delivers nothing between two pings is dead without
   * having been closed (a network switch, a NAT that dropped the flow) — it
   * is replaced, instead of showing "online" while calls and chat hints
   * silently go nowhere.
   */
  private startPing(): void {
    this.stopPing();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || this.status !== 'online') return;
      if (this.awaitingPong) {
        this.abandon(socket);
        return;
      }
      this.awaitingPong = true;
      socket.send(JSON.stringify({ type: 'ping' }));
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
