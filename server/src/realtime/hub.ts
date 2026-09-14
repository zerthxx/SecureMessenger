import type { ServerEvent } from './protocol.js';

/** The subset of a `ws` WebSocket the hub needs — lets tests use plain fakes. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeConnection {
  userId: string;
  deviceId: string;
  socket: RealtimeSocket;
}

const OPEN = 1;

/**
 * Who is connected right now, by device and by account. One live connection
 * per device: a reconnect replaces (and the caller closes) the previous one.
 *
 * In-memory, like lib/rateLimit.ts: correct for the single-instance
 * deployment. Running more than one server instance would need a shared
 * pub/sub (e.g. Redis) so an event reaches a device connected elsewhere.
 */
export class RealtimeHub {
  private readonly byDevice = new Map<string, RealtimeConnection>();
  private readonly byUser = new Map<string, Set<RealtimeConnection>>();

  /** Registers a connection; returns the connection it replaced for the same device, if any. */
  add(connection: RealtimeConnection): RealtimeConnection | undefined {
    const previous = this.byDevice.get(connection.deviceId);
    if (previous) this.detach(previous);
    this.byDevice.set(connection.deviceId, connection);
    let set = this.byUser.get(connection.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(connection.userId, set);
    }
    set.add(connection);
    return previous;
  }

  /** Unregisters a connection; returns true when it was the device's current one (i.e. the device is now offline). */
  remove(connection: RealtimeConnection): boolean {
    if (this.byDevice.get(connection.deviceId) !== connection) return false;
    this.detach(connection);
    return true;
  }

  isDeviceConnected(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  connectedDeviceIds(userId: string): string[] {
    return [...(this.byUser.get(userId) ?? [])].map((connection) => connection.deviceId);
  }

  /** Returns whether the event was handed to an open socket. */
  toDevice(deviceId: string, event: ServerEvent): boolean {
    const connection = this.byDevice.get(deviceId);
    return connection ? send(connection, event) : false;
  }

  /** Sends to every connected device of the account; returns the device ids reached. */
  toUser(userId: string, event: ServerEvent, options: { exceptDeviceId?: string } = {}): string[] {
    const reached: string[] = [];
    for (const connection of this.byUser.get(userId) ?? []) {
      if (connection.deviceId === options.exceptDeviceId) continue;
      if (send(connection, event)) reached.push(connection.deviceId);
    }
    return reached;
  }

  private detach(connection: RealtimeConnection): void {
    this.byDevice.delete(connection.deviceId);
    const set = this.byUser.get(connection.userId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.byUser.delete(connection.userId);
  }
}

function send(connection: RealtimeConnection, event: ServerEvent): boolean {
  if (connection.socket.readyState !== OPEN) return false;
  try {
    connection.socket.send(JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
}
