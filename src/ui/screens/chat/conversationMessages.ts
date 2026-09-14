import { useCallback, useSyncExternalStore } from 'react';

import type { Message } from '@/domain/entities';
import { getMessageStoreOwner, listRecentMessages, type MessageRow } from '@/infrastructure/storage/messageStore';

/**
 * The chat UI's view of the local message store.
 *
 * Previously every sync bumped one provider-wide counter, so every screen
 * using the chat context re-rendered and the open conversation re-read its
 * entire history from SQLite on every poll, even when nothing had changed
 * (measured: ~4.5 s of JS-thread time per minute with a 300-message chat
 * open). Here each open conversation has its own subscription, is re-read
 * only after a write that touched it, reads only its newest page (older
 * pages load as the list scrolls back), and keeps unchanged `Message`
 * objects so memoized bubbles skip re-rendering.
 */

export const MESSAGE_PAGE_SIZE = 50;

export interface ConversationMessagesSnapshot {
  /** Newest first — the order an inverted list renders. */
  messages: Message[];
  /** Whether this account has older messages stored beyond the loaded page(s). */
  hasOlder: boolean;
}

interface Entry {
  owner: string;
  conversationId: string;
  limit: number;
  stale: boolean;
  snapshot: ConversationMessagesSnapshot;
  listeners: Set<() => void>;
}

const EMPTY_SNAPSHOT: ConversationMessagesSnapshot = { messages: [], hasOlder: false };

// Only conversations currently on screen have an entry; it is dropped when
// the last subscriber leaves, so memory stays bounded by what is shown.
const entries = new Map<string, Entry>();

export function toMessage(row: MessageRow): Message {
  // Outgoing messages (sending/sent/failed) always store our own
  // authored plaintext and it's always safe to display it. Incoming
  // messages only ever have real plaintext once `status === 'decrypted'`
  // — `decryption_failed` rows have `plaintext === null` regardless of
  // direction, so this single check covers both correctly: never
  // surface text for a failed decryption, always surface it otherwise.
  // Voice messages never populate `text` at all — their content lives in
  // the audio* fields instead.
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderDeviceId: row.senderDeviceId,
    direction: row.direction,
    status: row.status,
    kind: row.kind,
    text: row.status === 'decryption_failed' || row.kind === 'voice' ? null : row.plaintext,
    audioMediaId: row.audioMediaId,
    audioDurationMs: row.audioDurationMs,
    audioLocalUri: row.audioLocalUri,
    audioState: row.audioState,
    createdAt: row.createdAt,
  };
}

function sameMessage(a: Message, b: Message): boolean {
  return (
    a.id === b.id &&
    a.conversationId === b.conversationId &&
    a.senderDeviceId === b.senderDeviceId &&
    a.direction === b.direction &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.audioMediaId === b.audioMediaId &&
    a.audioDurationMs === b.audioDurationMs &&
    a.audioLocalUri === b.audioLocalUri &&
    a.audioState === b.audioState &&
    a.createdAt === b.createdAt
  );
}

function entryKey(owner: string, conversationId: string): string {
  return `${owner}:${conversationId}`;
}

function getEntry(owner: string, conversationId: string): Entry {
  const key = entryKey(owner, conversationId);
  let entry = entries.get(key);
  if (!entry) {
    entry = { owner, conversationId, limit: MESSAGE_PAGE_SIZE, stale: true, snapshot: EMPTY_SNAPSHOT, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

/** Re-reads the loaded window, reusing every message object whose content didn't change (and the whole snapshot if nothing did). */
function reload(entry: Entry): void {
  entry.stale = false;
  let rows: MessageRow[];
  try {
    rows = listRecentMessages(entry.owner, entry.conversationId, entry.limit + 1);
  } catch {
    return; // keep showing the last good snapshot; the next change notification retries
  }

  const previous = entry.snapshot.messages;
  const previousById = new Map(previous.map((message) => [message.id, message]));
  const hasOlder = rows.length > entry.limit;
  const messages = rows.slice(0, entry.limit).map((row) => {
    const next = toMessage(row);
    const prior = previousById.get(next.id);
    return prior && sameMessage(prior, next) ? prior : next;
  });
  const unchanged =
    hasOlder === entry.snapshot.hasOlder &&
    messages.length === previous.length &&
    messages.every((message, index) => message === previous[index]);
  if (!unchanged) {
    entry.snapshot = { messages, hasOlder };
  }
}

function notifyListeners(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

/** Marks a conversation's loaded messages out of date and re-renders whatever shows it. Call after any store write for that conversation. */
export function notifyConversationChanged(conversationId: string): void {
  for (const entry of entries.values()) {
    if (entry.conversationId !== conversationId) continue;
    entry.stale = true;
    notifyListeners(entry);
  }
}

/** Loads one more page of older messages — called when the list reaches its oldest loaded message. */
export function loadOlderMessages(conversationId: string): void {
  for (const entry of entries.values()) {
    if (entry.conversationId !== conversationId || !entry.snapshot.hasOlder) continue;
    entry.limit += MESSAGE_PAGE_SIZE;
    entry.stale = true;
    notifyListeners(entry);
  }
}

/** Newest-first messages for one conversation, re-rendering only when that conversation's stored messages change. */
export function useConversationMessages(conversationId: string | undefined): ConversationMessagesSnapshot {
  const owner = getMessageStoreOwner();

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!owner || !conversationId) return () => {};
      const entry = getEntry(owner, conversationId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entries.get(entryKey(owner, conversationId)) === entry) {
          entries.delete(entryKey(owner, conversationId));
        }
      };
    },
    [owner, conversationId],
  );

  const getSnapshot = useCallback((): ConversationMessagesSnapshot => {
    if (!owner || !conversationId) return EMPTY_SNAPSHOT;
    const entry = getEntry(owner, conversationId);
    if (entry.stale) reload(entry);
    return entry.snapshot;
  }, [owner, conversationId]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
