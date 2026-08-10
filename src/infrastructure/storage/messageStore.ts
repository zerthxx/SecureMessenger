import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';

/**
 * Local cache of conversations and DECRYPTED message plaintext —
 * exists entirely so the chat UI has something to render and so a
 * message isn't re-decrypted on every poll (MLS application-message
 * decryption is not safely repeatable — see mlsCore.ts). Lives in the
 * app's private SQLite database (Android app-sandbox storage), the same
 * protection tier Phase 5C's original MLS group-state design used
 * before Phase 5D hardened that *specific* store further. Message
 * plaintext here is a materially different risk than MLS group secrets
 * (compromising one conversation's history vs. compromising the key
 * material for every past/future message in every group), so applying
 * the same Keystore-envelope-encryption treatment here was judged out
 * of proportion for this phase — see the Phase 6 report's "remaining
 * limitations" for the explicit tradeoff, which a future phase can
 * revisit the same way Phase 5D revisited Phase 5C's group-storage
 * boundary.
 *
 * Never persists anything to the SERVER — this file only ever talks to
 * the on-device SQLite file.
 */

export type MessageDirection = 'outgoing' | 'incoming';
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'decrypted' | 'decryption_failed';

export interface ConversationRow {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  groupJoined: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  direction: MessageDirection;
  status: MessageStatus;
  plaintext: string | null;
  createdAt: string;
  localCreatedAt: string;
}

let db: SQLiteDatabase | null = null;

function getDb(): SQLiteDatabase {
  if (!db) {
    db = openDatabaseSync('mls_chat_cache.db');
  }
  return db;
}

export function initMessageStore(): void {
  const database = getDb();
  database.execSync(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      other_user_id TEXT NOT NULL,
      other_username TEXT NOT NULL,
      other_display_name TEXT NOT NULL,
      group_joined INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      plaintext TEXT,
      created_at TEXT NOT NULL,
      local_created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function rowToConversation(row: {
  id: string;
  other_user_id: string;
  other_username: string;
  other_display_name: string;
  group_joined: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
}): ConversationRow {
  return {
    id: row.id,
    otherUserId: row.other_user_id,
    otherUsername: row.other_username,
    otherDisplayName: row.other_display_name,
    groupJoined: row.group_joined === 1,
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  };
}

function rowToMessage(row: {
  id: string;
  conversation_id: string;
  sender_device_id: string;
  direction: string;
  status: string;
  plaintext: string | null;
  created_at: string;
  local_created_at: string;
}): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderDeviceId: row.sender_device_id,
    direction: row.direction as MessageDirection,
    status: row.status as MessageStatus,
    plaintext: row.plaintext,
    createdAt: row.created_at,
    localCreatedAt: row.local_created_at,
  };
}

/** Inserts a conversation if new; on repeat calls, refreshes the other party's display fields but never resets `group_joined` or the last-message cache. */
export function upsertConversation(input: {
  id: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName: string;
  createdAt: string;
}): void {
  getDb().runSync(
    `INSERT INTO conversations (id, other_user_id, other_username, other_display_name, group_joined, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET other_username = excluded.other_username, other_display_name = excluded.other_display_name`,
    [input.id, input.otherUserId, input.otherUsername, input.otherDisplayName, input.createdAt],
  );
}

export function markConversationJoined(conversationId: string): void {
  getDb().runSync(`UPDATE conversations SET group_joined = 1 WHERE id = ?`, [conversationId]);
}

export function isConversationJoined(conversationId: string): boolean {
  const row = getDb().getFirstSync<{ group_joined: number }>(`SELECT group_joined FROM conversations WHERE id = ?`, [
    conversationId,
  ]);
  return row?.group_joined === 1;
}

export function getConversation(conversationId: string): ConversationRow | null {
  const row = getDb().getFirstSync<Parameters<typeof rowToConversation>[0]>(
    `SELECT * FROM conversations WHERE id = ?`,
    [conversationId],
  );
  return row ? rowToConversation(row) : null;
}

export function listLocalConversations(): ConversationRow[] {
  const rows = getDb().getAllSync<Parameters<typeof rowToConversation>[0]>(
    `SELECT * FROM conversations ORDER BY COALESCE(last_message_at, created_at) DESC`,
  );
  return rows.map(rowToConversation);
}

/**
 * Upserts a message row. Ordering (`createdAt`) and delivery status
 * always take the incoming value as authoritative on conflict (the
 * server's view wins) — but `plaintext` and a `decrypted` status, once
 * set, are never overwritten, since re-running decryption is not safe
 * (see mlsCore.ts) and the point of this cache is specifically to avoid
 * ever needing to.
 */
export function recordMessage(input: {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  direction: MessageDirection;
  status: MessageStatus;
  plaintext: string | null;
  createdAt: string;
  localCreatedAt: string;
}): void {
  getDb().runSync(
    `INSERT INTO messages (id, conversation_id, sender_device_id, direction, status, plaintext, created_at, local_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       status = CASE WHEN messages.status = 'decrypted' THEN messages.status ELSE excluded.status END,
       plaintext = CASE WHEN messages.plaintext IS NOT NULL THEN messages.plaintext ELSE excluded.plaintext END`,
    [
      input.id,
      input.conversationId,
      input.senderDeviceId,
      input.direction,
      input.status,
      input.plaintext,
      input.createdAt,
      input.localCreatedAt,
    ],
  );
}

/**
 * Renames a locally-generated optimistic id to the server's real message
 * id once `sendMessage` confirms. SQLite allows updating a TEXT primary
 * key in place — but a poll cycle can race this: if `fetchMessages`
 * returns this same (now-persisted) message before this reconcile runs,
 * `pollConversation` will have already inserted a placeholder row under
 * `serverId` (since it won't find `serverId` locally yet either). That
 * placeholder is deleted first so the rename below can never collide
 * with it — our own just-sent plaintext is always the authoritative
 * content for a message we authored, overriding any placeholder a race
 * created.
 */
export function reconcileSentMessageId(localId: string, serverId: string, createdAt: string): void {
  const database = getDb();
  database.withTransactionSync(() => {
    if (localId !== serverId) {
      database.runSync(`DELETE FROM messages WHERE id = ?`, [serverId]);
    }
    database.runSync(`UPDATE messages SET id = ?, status = 'sent', created_at = ? WHERE id = ?`, [
      serverId,
      createdAt,
      localId,
    ]);
  });
}

export function updateMessageStatus(id: string, status: MessageStatus): void {
  getDb().runSync(`UPDATE messages SET status = ? WHERE id = ?`, [status, id]);
}

export function getMessageById(id: string): MessageRow | null {
  const row = getDb().getFirstSync<Parameters<typeof rowToMessage>[0]>(`SELECT * FROM messages WHERE id = ?`, [id]);
  return row ? rowToMessage(row) : null;
}

export function listMessagesForConversation(conversationId: string): MessageRow[] {
  const rows = getDb().getAllSync<Parameters<typeof rowToMessage>[0]>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, local_created_at ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

/** Refreshes the chat-list preview fields from this conversation's newest message. Call after any recordMessage that could be the newest. */
export function refreshConversationPreview(conversationId: string): void {
  const latest = getDb().getFirstSync<{ plaintext: string | null; status: string; created_at: string }>(
    `SELECT plaintext, status, created_at FROM messages
     WHERE conversation_id = ? AND direction IN ('incoming', 'outgoing')
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  if (!latest) return;
  const preview =
    latest.status === 'decrypted'
      ? latest.plaintext
      : latest.status === 'decryption_failed'
        ? 'Unable to decrypt this message'
        : latest.status === 'failed'
          ? 'Message failed to send'
          : 'Message';
  getDb().runSync(`UPDATE conversations SET last_message_preview = ?, last_message_at = ? WHERE id = ?`, [
    preview,
    latest.created_at,
    conversationId,
  ]);
}

export function getAppState(key: string): string | null {
  const row = getDb().getFirstSync<{ value: string }>(`SELECT value FROM app_state WHERE key = ?`, [key]);
  return row?.value ?? null;
}

export function setAppState(key: string, value: string): void {
  getDb().runSync(`INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
    key,
    value,
  ]);
}
