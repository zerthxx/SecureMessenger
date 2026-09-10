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
 *
 * ACCOUNT ISOLATION: this SQLite file is one per app *install*, not one
 * per account — switching accounts on the same device (sign out, sign
 * back in as someone else) reuses the same file. An earlier version of
 * this module handled that by deleting every row on logout
 * (`clearAllLocalData`), but that also destroyed the signed-out
 * account's own decrypted message plaintext — which, per the module doc
 * above, is NOT safely re-derivable: MLS erases a message's decryption
 * key right after first use, so once the local plaintext cache for a
 * message is gone, that message can never be decrypted again by anyone,
 * including its rightful owner logging back in. That is a data-loss bug,
 * not a fix.
 *
 * Instead, `conversations` and `messages` rows are tagged with the
 * account that owns them (`owner_user_id`). Every read/write below takes
 * an explicit `owner` argument — the caller's job is to capture that
 * value ONCE, via `getMessageStoreOwner()`, at the very start of an
 * async operation, and pass the SAME captured value to every store call
 * that operation makes, rather than letting each call independently
 * re-read whatever the *current* global owner happens to be by the time
 * it runs. `setMessageStoreOwner` still updates that global (ChatContext
 * calls it whenever the authenticated account changes) — it's the
 * *write* functions below that additionally assert the caller's
 * captured owner still matches it before touching SQLite, so a request
 * started under account A that only resolves after A has logged out and
 * a different account has logged in can never write A's data under the
 * new account, or anything at all: the stale write is thrown away, not
 * silently reattributed. Nothing is ever deleted on logout — an
 * account's rows simply become unreadable (owner mismatch) until that
 * same account signs back in, at which point they become visible again,
 * exactly as they were left. `app_state` is intentionally NOT
 * owner-scoped: every key in it is already namespaced by a
 * globally-unique server id (a deviceId, conversationId, or messageId),
 * so a different account reusing one of those flags is a harmless,
 * redundant idempotency check, never a data leak.
 */

export type MessageDirection = 'outgoing' | 'incoming';
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'decrypted' | 'decryption_failed';
export type MessageKind = 'text' | 'voice';
export type AudioState = 'idle' | 'downloading' | 'downloaded' | 'failed';

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
  kind: MessageKind;
  plaintext: string | null;
  /** Voice-message metadata — only meaningful when `kind === 'voice'`. */
  audioMediaId: string | null;
  audioDurationMs: number | null;
  audioLocalUri: string | null;
  audioState: AudioState | null;
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

/** Adds `column` to `table` if an earlier install created the table without it — additive only, never touches existing rows/columns. */
function ensureColumn(database: SQLiteDatabase, table: string, column: string, type: string): void {
  const existing = database.getAllSync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!existing.some((c) => c.name === column)) {
    database.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
      created_at TEXT NOT NULL,
      owner_user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      plaintext TEXT,
      created_at TEXT NOT NULL,
      local_created_at TEXT NOT NULL,
      owner_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Installs that created these tables before `owner_user_id` existed
  // won't pick it up from `CREATE TABLE IF NOT EXISTS` above — add it
  // without touching any existing row. Those legacy rows keep a NULL
  // owner (invisible to every account) until the conversation's real
  // owner next syncs it from the server, which backfills the correct
  // owner via the ON CONFLICT clauses below.
  ensureColumn(database, 'conversations', 'owner_user_id', 'TEXT');
  ensureColumn(database, 'messages', 'owner_user_id', 'TEXT');
  // Voice messages (additive, same backfill pattern as owner_user_id
  // above): 'kind' defaults every pre-existing row to 'text', which is
  // exactly what they are. The audio_* columns stay NULL for those rows
  // and are only ever populated for kind = 'voice'.
  ensureColumn(database, 'messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
  ensureColumn(database, 'messages', 'audio_media_id', 'TEXT');
  ensureColumn(database, 'messages', 'audio_duration_ms', 'INTEGER');
  ensureColumn(database, 'messages', 'audio_local_uri', 'TEXT');
  ensureColumn(database, 'messages', 'audio_state', 'TEXT');
}

// Set by ChatContext whenever the authenticated account changes (login,
// logout, or switching accounts). This is intentionally the ONLY piece
// of global mutable state here — every function below is handed an
// explicit `owner` by its caller instead of reading this directly,
// except to check whether that caller's captured value is still current.
let ownerUserId: string | null = null;

export function setMessageStoreOwner(userId: string | null): void {
  ownerUserId = userId;
}

/**
 * Snapshot of "who is authenticated right now". Call this ONCE at the
 * very start of an async operation and thread the returned value through
 * every messageStore call that operation makes — never call this again
 * mid-operation expecting the same answer, since it can change under you
 * across an `await` (that's exactly the race this whole scheme guards
 * against).
 */
export function getMessageStoreOwner(): string | null {
  return ownerUserId;
}

export function hasMessageStoreOwner(): boolean {
  return ownerUserId !== null;
}

/**
 * Hard backstop for every write below: throws if the account that
 * captured `expectedOwner` is no longer the authenticated account,
 * discarding the write rather than either running it under the new
 * account or silently dropping it without signal. Callers are expected
 * to check `getMessageStoreOwner() === capturedOwner` proactively right
 * after each `await` for clean control flow — this assertion is the
 * guarantee that holds even if a caller forgets to.
 */
function assertOwnerUnchanged(expectedOwner: string): void {
  if (ownerUserId !== expectedOwner) {
    throw new Error('messageStore: the authenticated account changed since this operation began; write discarded');
  }
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
  kind: string | null;
  plaintext: string | null;
  audio_media_id: string | null;
  audio_duration_ms: number | null;
  audio_local_uri: string | null;
  audio_state: string | null;
  created_at: string;
  local_created_at: string;
}): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderDeviceId: row.sender_device_id,
    direction: row.direction as MessageDirection,
    status: row.status as MessageStatus,
    kind: (row.kind as MessageKind | null) ?? 'text',
    plaintext: row.plaintext,
    audioMediaId: row.audio_media_id,
    audioDurationMs: row.audio_duration_ms,
    audioLocalUri: row.audio_local_uri,
    audioState: row.audio_state as AudioState | null,
    createdAt: row.created_at,
    localCreatedAt: row.local_created_at,
  };
}

/**
 * Inserts a conversation if new; on repeat calls, refreshes the other
 * party's display fields but never resets `group_joined` or the
 * last-message cache. `owner` is stamped on every call for the same
 * self-healing reason described in the module doc (a legacy/NULL-owner
 * row becomes correctly owned the moment its rightful account syncs it
 * again) — but only after confirming `owner` is still the live account.
 */
export function upsertConversation(
  owner: string,
  input: {
    id: string;
    otherUserId: string;
    otherUsername: string;
    otherDisplayName: string;
    createdAt: string;
  },
): void {
  assertOwnerUnchanged(owner);
  getDb().runSync(
    `INSERT INTO conversations (id, other_user_id, other_username, other_display_name, group_joined, created_at, owner_user_id)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET other_username = excluded.other_username, other_display_name = excluded.other_display_name, owner_user_id = excluded.owner_user_id`,
    [input.id, input.otherUserId, input.otherUsername, input.otherDisplayName, input.createdAt, owner],
  );
}

export function markConversationJoined(owner: string, conversationId: string): void {
  assertOwnerUnchanged(owner);
  getDb().runSync(`UPDATE conversations SET group_joined = 1 WHERE id = ? AND owner_user_id = ?`, [conversationId, owner]);
}

export function isConversationJoined(owner: string, conversationId: string): boolean {
  const row = getDb().getFirstSync<{ group_joined: number }>(
    `SELECT group_joined FROM conversations WHERE id = ? AND owner_user_id = ?`,
    [conversationId, owner],
  );
  return row?.group_joined === 1;
}

export function getConversation(owner: string, conversationId: string): ConversationRow | null {
  const row = getDb().getFirstSync<Parameters<typeof rowToConversation>[0]>(
    `SELECT * FROM conversations WHERE id = ? AND owner_user_id = ?`,
    [conversationId, owner],
  );
  return row ? rowToConversation(row) : null;
}

export function listLocalConversations(owner: string): ConversationRow[] {
  const rows = getDb().getAllSync<Parameters<typeof rowToConversation>[0]>(
    `SELECT * FROM conversations WHERE owner_user_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC`,
    [owner],
  );
  return rows.map(rowToConversation);
}

/**
 * Upserts a message row. Ordering (`createdAt`) and delivery status
 * always take the incoming value as authoritative on conflict (the
 * server's view wins) — but `plaintext` and a `decrypted` status, once
 * set, are never overwritten, since re-running decryption is not safe
 * (see mlsCore.ts) and the point of this cache is specifically to avoid
 * ever needing to. `owner` is (re-)stamped on every call for the same
 * self-healing reason as `upsertConversation`, gated the same way on
 * `owner` still being the live account.
 */
export function recordMessage(
  owner: string,
  input: {
    id: string;
    conversationId: string;
    senderDeviceId: string;
    direction: MessageDirection;
    status: MessageStatus;
    /** @default 'text' */
    kind?: MessageKind;
    plaintext: string | null;
    audioMediaId?: string | null;
    audioDurationMs?: number | null;
    audioLocalUri?: string | null;
    audioState?: AudioState | null;
    createdAt: string;
    localCreatedAt: string;
  },
): void {
  assertOwnerUnchanged(owner);
  getDb().runSync(
    `INSERT INTO messages (id, conversation_id, sender_device_id, direction, status, kind, plaintext, audio_media_id, audio_duration_ms, audio_local_uri, audio_state, created_at, local_created_at, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       created_at = excluded.created_at,
       status = CASE WHEN messages.status = 'decrypted' THEN messages.status ELSE excluded.status END,
       plaintext = CASE WHEN messages.plaintext IS NOT NULL THEN messages.plaintext ELSE excluded.plaintext END,
       kind = excluded.kind,
       audio_media_id = CASE WHEN messages.audio_media_id IS NOT NULL THEN messages.audio_media_id ELSE excluded.audio_media_id END,
       audio_duration_ms = CASE WHEN messages.audio_duration_ms IS NOT NULL THEN messages.audio_duration_ms ELSE excluded.audio_duration_ms END,
       audio_local_uri = CASE WHEN messages.audio_local_uri IS NOT NULL THEN messages.audio_local_uri ELSE excluded.audio_local_uri END,
       audio_state = CASE WHEN messages.audio_state = 'downloaded' THEN messages.audio_state ELSE excluded.audio_state END,
       owner_user_id = excluded.owner_user_id`,
    [
      input.id,
      input.conversationId,
      input.senderDeviceId,
      input.direction,
      input.status,
      input.kind ?? 'text',
      input.plaintext,
      input.audioMediaId ?? null,
      input.audioDurationMs ?? null,
      input.audioLocalUri ?? null,
      input.audioState ?? null,
      input.createdAt,
      input.localCreatedAt,
      owner,
    ],
  );
}

/**
 * Updates a voice message's local-audio lifecycle fields only — used
 * once a recording is written locally (sender) or a received blob is
 * downloaded+decrypted (recipient). Never touches `plaintext`/`status`.
 */
export function updateVoiceAudio(
  owner: string,
  id: string,
  input: { audioLocalUri?: string | null; audioState: AudioState },
): void {
  assertOwnerUnchanged(owner);
  if (input.audioLocalUri !== undefined) {
    getDb().runSync(`UPDATE messages SET audio_local_uri = ?, audio_state = ? WHERE id = ? AND owner_user_id = ?`, [
      input.audioLocalUri,
      input.audioState,
      id,
      owner,
    ]);
  } else {
    getDb().runSync(`UPDATE messages SET audio_state = ? WHERE id = ? AND owner_user_id = ?`, [input.audioState, id, owner]);
  }
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
export function reconcileSentMessageId(owner: string, localId: string, serverId: string, createdAt: string): void {
  assertOwnerUnchanged(owner);
  const database = getDb();
  database.withTransactionSync(() => {
    if (localId !== serverId) {
      database.runSync(`DELETE FROM messages WHERE id = ? AND owner_user_id = ?`, [serverId, owner]);
    }
    database.runSync(`UPDATE messages SET id = ?, status = 'sent', created_at = ? WHERE id = ? AND owner_user_id = ?`, [
      serverId,
      createdAt,
      localId,
      owner,
    ]);
  });
}

export function updateMessageStatus(owner: string, id: string, status: MessageStatus): void {
  assertOwnerUnchanged(owner);
  getDb().runSync(`UPDATE messages SET status = ? WHERE id = ? AND owner_user_id = ?`, [status, id, owner]);
}

/** Stamps the server-issued media id onto a voice message once its blob upload confirms — see ChatContext's `attemptSendVoice`. */
export function setVoiceMediaId(owner: string, id: string, mediaId: string): void {
  assertOwnerUnchanged(owner);
  getDb().runSync(`UPDATE messages SET audio_media_id = ? WHERE id = ? AND owner_user_id = ?`, [mediaId, id, owner]);
}

export function getMessageById(owner: string, id: string): MessageRow | null {
  const row = getDb().getFirstSync<Parameters<typeof rowToMessage>[0]>(`SELECT * FROM messages WHERE id = ? AND owner_user_id = ?`, [
    id,
    owner,
  ]);
  return row ? rowToMessage(row) : null;
}

export function listMessagesForConversation(owner: string, conversationId: string): MessageRow[] {
  const rows = getDb().getAllSync<Parameters<typeof rowToMessage>[0]>(
    `SELECT * FROM messages WHERE conversation_id = ? AND owner_user_id = ? ORDER BY created_at ASC, local_created_at ASC`,
    [conversationId, owner],
  );
  return rows.map(rowToMessage);
}

/** Refreshes the chat-list preview fields from this conversation's newest message. Call after any recordMessage that could be the newest. */
export function refreshConversationPreview(owner: string, conversationId: string): void {
  const latest = getDb().getFirstSync<{ plaintext: string | null; status: string; kind: string | null; created_at: string }>(
    `SELECT plaintext, status, kind, created_at FROM messages
     WHERE conversation_id = ? AND owner_user_id = ? AND direction IN ('incoming', 'outgoing')
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId, owner],
  );
  if (!latest) return;
  assertOwnerUnchanged(owner);
  const isVoice = latest.kind === 'voice';
  const preview =
    latest.status === 'decryption_failed'
      ? 'Unable to decrypt this message'
      : latest.status === 'failed'
        ? isVoice
          ? 'Voice message failed to send'
          : 'Message failed to send'
        : isVoice
          ? '🎤 Voice message'
          : latest.status === 'decrypted'
            ? latest.plaintext
            : 'Message';
  getDb().runSync(`UPDATE conversations SET last_message_preview = ?, last_message_at = ? WHERE id = ? AND owner_user_id = ?`, [
    preview,
    latest.created_at,
    conversationId,
    owner,
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
