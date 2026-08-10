import {
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Raw bytes for encrypted payloads. Postgres `bytea`, not `text` — a
 * ciphertext column should never be coerced through a string encoding
 * by the schema layer.
 */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android', 'web']);
export const conversationTypeEnum = pgEnum('conversation_type', ['direct', 'group']);
export const memberRoleEnum = pgEnum('member_role', ['member', 'admin']);
// 'welcome': an MLS Welcome message (device join bootstrap, single
// recipient device, consumed once). 'application': an ordinary
// encrypted chat message. Both are opaque bytes to the server either
// way — this only affects delivery/routing, never decryption.
export const messageTypeEnum = pgEnum('message_type', ['application', 'welcome']);

/**
 * A person. Never stores a plaintext password or recovery code — only
 * Argon2id hashes of each, per the Phase 2 ADR (§07, §08).
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Always stored lowercase — case-insensitive uniqueness lives in the
  // column itself, not in application-layer comparisons that are easy
  // to forget at some call site.
  username: varchar('username', { length: 32 }).notNull().unique(),
  // Free-form, not used for lookups or as an identifier anywhere.
  displayName: varchar('display_name', { length: 50 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  recoveryCodeHash: text('recovery_code_hash').notNull(),
  // Account-level E2EE cross-signing key (Ed25519 public bytes, Phase 5A
  // §4). Nullable: absent until the account's first device generates it,
  // and — per the approved Phase 5A/5B recovery rule — never regenerated
  // or restored by the recovery flow. Public only; the private half never
  // leaves the device that created it.
  identitySigningPublicKey: bytea('identity_signing_public_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per logged-in device, not per user session. This is the
 * device-first requirement from the Phase 2 ADR (§06): multi-device and
 * future per-device E2EE keys both hang off this table without a schema
 * change later. `identityPublicKey` etc. are deliberately NOT added yet —
 * that arrives with the E2EE phase, not before.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    pushToken: text('push_token'),
    refreshTokenHash: text('refresh_token_hash'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    // E2EE device identity (Phase 5A §4/§5, Phase 5B). Both nullable:
    // absent until this device runs E2EE setup, and — same as
    // identitySigningPublicKey on `users` — never touched by recovery.
    // mlsCredentialPublicKey: this device's MLS credential signing key
    // (Ed25519 public bytes). identityCrossSignature: signature over
    // that key produced by the account's identitySigningPublicKey,
    // proving this device belongs to the account (cross-signing).
    mlsCredentialPublicKey: bytea('mls_credential_public_key'),
    identityCrossSignature: bytea('identity_cross_signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('devices_user_id_idx').on(table.userId)],
);

/**
 * Published, unconsumed MLS KeyPackages for a device (Phase 5A §3/§9 —
 * the prekey-equivalent other devices consume to add this device to a
 * group). Rows hold public KeyPackage bytes only — the matching private
 * key material lives exclusively in the device's local encrypted store
 * and is never sent to the server. A row is deleted once consumed
 * (KeyPackages are single-use); this table is not yet read or written by
 * any route in Phase 5B — publish/consume endpoints arrive with group
 * messaging.
 */
export const deviceKeyPackages = pgTable(
  'device_key_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    publicKeyPackage: bytea('public_key_package').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('device_key_packages_device_id_idx').on(table.deviceId)],
);

/** A direct (1:1) or group conversation. Group metadata (name, avatar) arrives with the groups feature. */
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: conversationTypeEnum('type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }),
    index('conversation_members_user_id_idx').on(table.userId),
  ],
);

/**
 * `ciphertext` is opaque to the server from the very first row — see the
 * Phase 2 ADR (§10). Today it holds whatever bytes the client sends
 * (no E2EE yet); later it holds real Signal Protocol ciphertext. The
 * column, and everything that reads/writes it, never needs to change.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderDeviceId: uuid('sender_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    // Only set for messageType = 'welcome' — a Welcome is addressed to
    // exactly one joining device, unlike an application message which
    // any device in the conversation may fetch. Phase 5C minimal
    // schema: reuses this same table/route rather than adding a
    // dedicated one for handshake messages.
    recipientDeviceId: uuid('recipient_device_id').references(() => devices.id, { onDelete: 'cascade' }),
    messageType: messageTypeEnum('message_type').notNull().default('application'),
    ciphertext: bytea('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
    index('messages_sender_device_id_idx').on(table.senderDeviceId),
    index('messages_recipient_device_id_idx').on(table.recipientDeviceId),
  ],
);

export const deliveryReceipts = pgTable(
  'delivery_receipts',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.deviceId] })],
);

/**
 * Append-only security log — login/recovery/device events. Never write
 * a password, token, recovery code, or message plaintext into `metadata`.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 40 }).notNull(),
    ipHash: text('ip_hash'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_events_user_id_created_at_idx').on(table.userId, table.createdAt)],
);

/*
 * Deliberately not modeled yet:
 *   - media_objects  (arrives with the media-upload phase)
 *   - stories        (arrives with the stories phase)
 *
 * Deliberately NOT added even though Phase 5C introduces real MLS
 * groups: a server-side "mls_groups" table. The app reuses each
 * conversation's own (already random) UUID as the MLS GroupId directly
 * (see the mls-core Rust crate's group.rs), so `conversations` already
 * *is* the group-routing table — a separate one would just duplicate
 * conversationId with no new information the server is allowed to see
 * anyway (group membership topology is already `conversationMembers`).
 */
