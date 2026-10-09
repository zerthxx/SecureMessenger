import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { conversationMembers, conversations, deviceKeyPackages, devices, messages, users } from '../../db/schema.js';
import { notifyNewMessage } from '../../lib/pushDelivery.js';
import { resetGroupTestDelayMs, takeDroppedResetResponse } from '../../lib/testHooks.js';
import { publishConversationUpdated } from '../../realtime/instance.js';
import type { Context } from '../context.js';
import { enforceRateLimit, protectedProcedure, router, sheddableProcedure } from '../trpc.js';

/**
 * Phase 5D hardening: rejects the call if the *caller's own* device
 * (`ctx.device.id`, trusted from the access token — see context.ts) has
 * since been revoked. `context.ts` deliberately doesn't hit the database
 * on every request (a per-request DB check there would turn the
 * intentionally stateless, JWT-expiry-based auth model into a
 * semi-stateful one for every single endpoint, which is a bigger change
 * than this phase's "harden, don't rebuild" scope) — that leaves up to a
 * ~15-minute window (the access token TTL) where a just-revoked device's
 * token still verifies. For the specific E2EE endpoints where a revoked
 * device actively publishing new trust material or messages during that
 * window would matter most (as opposed to e.g. read-only polling), this
 * closes that window with one targeted DB check rather than changing the
 * shared auth middleware everyone else also goes through.
 */
async function assertCallerDeviceActive(ctx: Pick<Context, 'db'> & { device: { id: string } }): Promise<void> {
  const [device] = await ctx.db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, ctx.device.id)).limit(1);
  if (!device || device.revokedAt) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This device has been signed out.' });
  }
}

/**
 * Ciphertext transport for the Phase 5C E2EE proof. No transformer is
 * configured for this tRPC router (plain JSON over the wire, per the
 * existing Phase 4 setup), so binary payloads — KeyPackages, Welcome
 * messages, application ciphertext — travel as base64 strings and are
 * decoded to `Buffer` immediately at the boundary, before anything
 * touches the database. Every column these write to is `bytea`; nothing
 * here ever inspects, transforms, or logs the decoded bytes' content —
 * see the Phase 5C report's "what the server can/can't see" section.
 */
const base64Bytes = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length > 0;
    } catch {
      return false;
    }
  },
  { message: 'Expected non-empty base64-encoded bytes' },
);

/**
 * A device that hasn't used the API for this long is treated as gone for
 * group purposes: a wiped or reinstalled phone never signs out, so its old
 * row otherwise stays addressable until its session TTL (months) — every
 * rebuild keeps sending it Welcomes and burning its KeyPackages, and its
 * dead leaf stays in the group. A live device that comes back later
 * simply finds itself outside the current group and rebuilds; nothing is
 * lost for it.
 */
export const ADDRESSABLE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A device other devices may address a Welcome to: signed in (not revoked,
 * refresh token not expired — an expired one can never come back without a
 * new login, which is a new device row), finished E2EE setup, and seen
 * within ADDRESSABLE_IDLE_MS. Previously only `revokedAt` was checked, so
 * a device abandoned without signing out (reinstall, wiped phone) stayed
 * "active" and kept soaking up Welcomes and KeyPackages until its session
 * TTL passed.
 */
function isAddressableDevice(now: Date) {
  return and(
    isNull(devices.revokedAt),
    isNotNull(devices.mlsCredentialPublicKey),
    or(isNull(devices.refreshTokenExpiresAt), gt(devices.refreshTokenExpiresAt, now)),
    gt(devices.lastSeenAt, new Date(now.getTime() - ADDRESSABLE_IDLE_MS)),
  );
}

/**
 * KeyPackages older than this are never handed out and are deleted when
 * seen. OpenMLS gives a KeyPackage a 12-week lifetime and rejects adding an
 * expired one; the app used to publish exactly one batch per device, so
 * after ~84 days a device became impossible to add to any conversation.
 */
export const KEY_PACKAGE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** What `sendMessage` rejects with when the sender encrypted for a group the conversation no longer uses. */
export const STALE_GROUP_GENERATION = 'STALE_GROUP_GENERATION';

export const UPDATE_REQUIRED = 'This conversation now needs the latest version of SecureMessenger. Please update the app.';

async function assertMember(ctx: Pick<Context, 'db'> & { user: { id: string } }, conversationId: string): Promise<void> {
  const [membership] = await ctx.db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, ctx.user.id)))
    .limit(1);
  if (!membership) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this conversation.' });
  }
}

/**
 * Whether the caller may address `targetUserId`'s devices (list them, use up
 * their KeyPackages): its own, or those of someone it shares a conversation
 * with — createConversation always comes before adding anyone to a group.
 * A stranger has no use for either; only an attacker draining or mapping
 * someone's devices would.
 */
async function sharesConversationOrSelf(ctx: Pick<Context, 'db'> & { user: { id: string } }, targetUserId: string): Promise<boolean> {
  if (targetUserId === ctx.user.id) return true;
  const target = alias(conversationMembers, 'target_member');
  const [shared] = await ctx.db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(target, and(eq(target.conversationId, conversationMembers.conversationId), eq(target.userId, targetUserId)))
    .where(eq(conversationMembers.userId, ctx.user.id))
    .limit(1);
  return !!shared;
}

/**
 * `sinceCreatedAt` makes a fetch incremental: only rows created at or after
 * that instant. Clients send their newest already-processed row's timestamp
 * minus an overlap window and skip ids they already hold, so a row whose
 * insert committed a moment after a later-stamped row is still seen.
 * Omitted, the full history is returned — what app versions from before
 * incremental sync still request.
 */
/** Most rows one paged fetchMessages call returns. */
export const MAX_PAGE_ROWS = 500;
/**
 * Most rows a fetchMessages call without `page` returns (app versions from
 * before paging). It used to have no limit, so one call on a long
 * conversation read, encoded and sent its entire history. Ascending order
 * keeps it safe for those versions: they move their sync cursor to the
 * newest row they got, so the next sync carries on from there.
 */
export const LEGACY_MAX_ROWS = 5000;
/** `<created_at in UTC with microseconds>_<id>` — exact, unlike the millisecond `createdAt`. */
const PAGE_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const rowCursor = sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '_' || ${messages.id}::text`;

const fetchMessagesInput = z.object({
  conversationId: z.string().uuid(),
  sinceCreatedAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Opt-in paging (see fetchMessages). `after` is the `cursor` of the last
   * in-page row of the previous page; the first page of a sync omits it.
   */
  page: z
    .object({
      limit: z.number().int().min(1).max(MAX_PAGE_ROWS),
      after: z.string().regex(PAGE_CURSOR_RE).optional(),
    })
    .optional(),
});

export const e2eeRouter = router({
  /**
   * Phase 6: writes the account-level MLS identity signing public key
   * (`users.identitySigningPublicKey`) — a column that has existed since
   * Phase 5A/5B but that no endpoint ever wrote to until now. This key
   * is meant to exist exactly once per account, generated by whichever
   * device runs E2EE setup first; set-once/idempotent rather than
   * overwritable, matching the approved design ("never regenerated or
   * restored by recovery" — see auth.ts's recovery flow doc comment).
   * If the account already has one on file, this call is a no-op
   * returning success rather than an error, so a device's own retry or
   * an app-restart re-running setup doesn't fail — it simply does not
   * overwrite whatever the account's first device already established.
   * A second *device* of the same account generating its own, different
   * identity key is a real multi-device-linking gap this phase does not
   * solve (see the Phase 6 report's "remaining limitations") — it is
   * silently not adopted here rather than corrupting the account's one
   * true identity key.
   */
  registerIdentityKey: protectedProcedure
    .input(z.object({ publicKey: base64Bytes }))
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`e2ee:registerIdentityKey:device:${ctx.device.id}`, 60, 60 * 60 * 1000);
      await assertCallerDeviceActive(ctx);

      await ctx.db
        .update(users)
        .set({ identitySigningPublicKey: Buffer.from(input.publicKey, 'base64') })
        .where(and(eq(users.id, ctx.user.id), isNull(users.identitySigningPublicKey)));

      return { registered: true as const };
    }),

  /**
   * Phase 6: writes this device's MLS credential public key and its
   * cross-signature (`devices.mlsCredentialPublicKey` /
   * `identityCrossSignature`) — same "declared since Phase 5A/5B, never
   * written until now" gap as `registerIdentityKey`, scoped per-device
   * instead of per-account. Set-once/idempotent for the same reason.
   */
  registerDeviceCredential: protectedProcedure
    .input(z.object({ credentialPublicKey: base64Bytes, crossSignature: base64Bytes }))
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`e2ee:registerDeviceCredential:device:${ctx.device.id}`, 60, 60 * 60 * 1000);
      await assertCallerDeviceActive(ctx);

      await ctx.db
        .update(devices)
        .set({
          mlsCredentialPublicKey: Buffer.from(input.credentialPublicKey, 'base64'),
          identityCrossSignature: Buffer.from(input.crossSignature, 'base64'),
        })
        .where(and(eq(devices.id, ctx.device.id), isNull(devices.mlsCredentialPublicKey)));

      return { registered: true as const };
    }),

  /** Publishes this device's freshly-generated public KeyPackages (Phase 5B `generateKeyPackages` output). */
  publishKeyPackages: protectedProcedure
    .input(z.object({ keyPackages: z.array(base64Bytes).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      // Publishing is infrequent (only when a device's KeyPackage pool
      // runs low) and bounded to 50 per call already — a generous cap is
      // mainly to stop a compromised/scripted device from flooding its
      // own row set.
      enforceRateLimit(`e2ee:publishKeyPackages:device:${ctx.device.id}`, 20, 60 * 60 * 1000);
      await assertCallerDeviceActive(ctx);

      await ctx.db.insert(deviceKeyPackages).values(
        input.keyPackages.map((kp) => ({
          deviceId: ctx.device.id,
          publicKeyPackage: Buffer.from(kp, 'base64'),
        })),
      );
      return { published: input.keyPackages.length };
    }),

  /**
   * Consumes (returns and deletes) one unconsumed KeyPackage for the
   * given device — KeyPackages are single-use, per OpenMLS's own
   * documentation (see the Phase 5A/5B research). Returns null if none
   * are currently published.
   *
   * Phase 5D: also requires the *target* device to still be active.
   * Unlike `listActiveDeviceIds` (which already filtered on
   * `revokedAt`), this endpoint previously looked up KeyPackages purely
   * by `deviceId` with no join against the device's revocation state —
   * so a caller who already knew a revoked device's ID could still be
   * handed a Welcome-addressable KeyPackage for it, if that device's rows
   * hadn't been cleaned up. Revoked devices must not be addressable as
   * trusted, active group members.
   */
  consumeKeyPackage: protectedProcedure
    .input(z.object({ targetDeviceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Consuming is how a caller adds a peer device to a group — bound
      // it generously above normal usage (group creation touches this a
      // handful of times, not dozens) to blunt scripted KeyPackage-pool
      // exhaustion against a target device.
      enforceRateLimit(`e2ee:consumeKeyPackage:device:${ctx.device.id}`, 30, 5 * 60 * 1000);
      await assertCallerDeviceActive(ctx);

      // Only a device the caller could legitimately add to a group (see
      // sharesConversationOrSelf). Answered like "none left", so it doesn't
      // reveal whether the device exists.
      const [target] = await ctx.db.select({ userId: devices.userId }).from(devices).where(eq(devices.id, input.targetDeviceId)).limit(1);
      if (!target || !(await sharesConversationOrSelf(ctx, target.userId))) {
        return { keyPackage: null };
      }

      // Audit fix: this was previously a SELECT then a separate DELETE.
      // Two concurrent consumeKeyPackage calls for the same
      // targetDeviceId (e.g. two people starting a conversation with the
      // same target at once, or a client retrying) could both SELECT the
      // same "unconsumed" row before either DELETEd it, handing out the
      // identical one-time KeyPackage twice — violating the single-use
      // invariant this endpoint's own doc comment above requires.
      // Locking the candidate row FOR UPDATE inside a transaction (with
      // SKIP LOCKED so a second concurrent caller finds no available row
      // instead of blocking on the first) makes select-then-delete
      // atomic with respect to other callers — the same class of fix
      // `createConversation` above already uses for its own concurrent
      // request race, just row-level instead of an advisory lock since
      // there's a concrete row to lock here.
      return ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: deviceKeyPackages.id, publicKeyPackage: deviceKeyPackages.publicKeyPackage })
          .from(deviceKeyPackages)
          .innerJoin(devices, eq(devices.id, deviceKeyPackages.deviceId))
          .where(
            and(
              eq(deviceKeyPackages.deviceId, input.targetDeviceId),
              gt(deviceKeyPackages.createdAt, new Date(Date.now() - KEY_PACKAGE_MAX_AGE_MS)),
              isAddressableDevice(new Date()),
            ),
          )
          .orderBy(asc(deviceKeyPackages.createdAt))
          .limit(1)
          .for('update', { of: deviceKeyPackages, skipLocked: true });

        // Expired ones can never be used; drop them so they stop counting as available.
        await tx
          .delete(deviceKeyPackages)
          .where(
            and(
              eq(deviceKeyPackages.deviceId, input.targetDeviceId),
              lt(deviceKeyPackages.createdAt, new Date(Date.now() - KEY_PACKAGE_MAX_AGE_MS)),
            ),
          );

        if (!row) {
          return { keyPackage: null };
        }

        await tx.delete(deviceKeyPackages).where(eq(deviceKeyPackages.id, row.id));

        ctx.log.info({ targetDeviceId: input.targetDeviceId }, 'key package consumed');
        return { keyPackage: row.publicKeyPackage.toString('base64') };
      });
    }),

  /**
   * Creates a direct conversation between the caller and another user.
   * Its ID doubles as the MLS GroupId (client-side only — see
   * schema.ts). Idempotent as of Phase 6: if the two users already have
   * a direct conversation, returns its existing id instead of creating
   * a duplicate — a "start conversation" UI action is naturally
   * re-triggerable (tapping a search result twice, re-opening an
   * existing chat via search) and must not fork a second, empty
   * conversation + a second MLS group each time.
   */
  createConversation: protectedProcedure
    .input(z.object({ otherUserId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`e2ee:createConversation:device:${ctx.device.id}`, 20, 60 * 60 * 1000);
      await assertCallerDeviceActive(ctx);

      if (input.otherUserId === ctx.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot create a conversation with yourself.' });
      }

      // Two concurrent calls for the same pair (double tap, a client
      // retrying a request it thinks failed, two devices of the same
      // account, or the other member starting the conversation from
      // their side at the same moment) previously raced the "check for
      // an existing direct conversation, else insert one" logic below:
      // both could read "none exists" before either had committed its
      // insert, producing two separate `conversations` rows for the same
      // pair. There's no schema-level uniqueness constraint on a
      // direct-conversation member pair (only conversation_members'
      // (conversation_id, user_id) primary key, which doesn't help
      // here), so the fix is to serialize this whole check-then-insert
      // per pair instead.
      //
      // pg_advisory_xact_lock is transaction-scoped — it auto-releases on
      // commit/rollback/connection loss, needs no manual unlock, and
      // costs nothing when uncontended. Keying it off the *sorted* pair
      // means both members' calls (or two devices of either) contend for
      // the exact same lock regardless of who calls first.
      return ctx.db.transaction(async (tx) => {
        const [a, b] = [ctx.user.id, input.otherUserId].sort();
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${a} || ':' || ${b}))`);

        const otherMembers = alias(conversationMembers, 'other_members_cc');
        const [existing] = await tx
          .select({ conversationId: conversations.id, groupGeneration: conversations.mlsGeneration })
          .from(conversationMembers)
          .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
          .innerJoin(
            otherMembers,
            and(eq(otherMembers.conversationId, conversationMembers.conversationId), eq(otherMembers.userId, input.otherUserId)),
          )
          .where(and(eq(conversationMembers.userId, ctx.user.id), eq(conversations.type, 'direct')))
          .limit(1);

        if (existing) {
          return { conversationId: existing.conversationId, groupGeneration: existing.groupGeneration };
        }

        const [conversation] = await tx
          .insert(conversations)
          .values({ type: 'direct' })
          .returning({ id: conversations.id });

        if (!conversation) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create conversation.' });
        }

        await tx.insert(conversationMembers).values([
          { conversationId: conversation.id, userId: ctx.user.id },
          { conversationId: conversation.id, userId: input.otherUserId },
        ]);

        return { conversationId: conversation.id, groupGeneration: 0 };
      });
    }),

  /**
   * Phase 6: lists the caller's direct (1:1) conversations, each paired
   * with the *other* member's public profile — this is what powers the
   * chat list. Deliberately returns no message content or preview text
   * (the server cannot decrypt, and this phase's chat-list preview is
   * built client-side from the local decrypted-message cache instead);
   * only conversation identity and the other participant's public
   * profile, both of which the caller is already a legitimate member of.
   * Group conversations (`type: 'group'`) are excluded — out of scope
   * for this phase.
   */
  listConversations: sheddableProcedure.query(async ({ ctx }) => {
    const otherMembers = alias(conversationMembers, 'other_members');

    const rows = await ctx.db
      .select({
        conversationId: conversations.id,
        createdAt: conversations.createdAt,
        mlsGeneration: conversations.mlsGeneration,
        mlsGenerationDeviceId: conversations.mlsGenerationDeviceId,
        otherUserId: users.id,
        otherUsername: users.username,
        otherDisplayName: users.displayName,
      })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .innerJoin(
        otherMembers,
        and(eq(otherMembers.conversationId, conversationMembers.conversationId), ne(otherMembers.userId, ctx.user.id)),
      )
      .innerJoin(users, eq(users.id, otherMembers.userId))
      .where(and(eq(conversationMembers.userId, ctx.user.id), eq(conversations.type, 'direct')))
      .orderBy(desc(conversations.createdAt));

    return rows.map((row) => ({
      conversationId: row.conversationId,
      createdAt: row.createdAt.toISOString(),
      // Which generation of the conversation's MLS group is current (see
      // resetGroup); 0 means none yet. Older app versions ignore it.
      groupGeneration: row.mlsGeneration,
      // Whether the calling device is the one that established it — lets a
      // device that lost resetGroup's answer (or was killed right after
      // sending it) find out that its own group is the current one instead
      // of rebuilding again. Additive; older app versions ignore it.
      groupBuiltByThisDevice: row.mlsGenerationDeviceId === ctx.device.id,
      otherUser: { id: row.otherUserId, username: row.otherUsername, displayName: row.otherDisplayName },
    }));
  }),

  /**
   * Stores one opaque ciphertext blob — an application message or an
   * MLS Welcome — for later retrieval. The server never decodes,
   * inspects, or transforms `ciphertext` beyond base64->Buffer; it is
   * bytea end to end.
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        conversationId: z.string().uuid(),
        ciphertext: base64Bytes,
        messageType: z.enum(['application', 'welcome']),
        // Required for 'welcome' (single addressed device), must be
        // absent for 'application' (any conversation member may fetch it).
        recipientDeviceId: z.string().uuid().optional(),
        // The group generation an application message was encrypted in.
        // When given, the message is refused (STALE_GROUP_GENERATION) if the
        // conversation has moved on to another group, so the sender
        // re-encrypts it for the current one instead of every other device
        // storing it as undecryptable. Omitted by app versions from before
        // generations existed.
        mlsGeneration: z.number().int().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Generous per-device budget matched to a real chat's cadence
      // (bursts of several messages/sec are normal) while still bounding
      // a scripted flood. 60/min was reachable by a fast typist sending
      // one-word messages, and every refusal showed as "Failed to send".
      enforceRateLimit(`e2ee:sendMessage:device:${ctx.device.id}`, 120, 60 * 1000);

      // This is the hottest write path, and the database is far from the
      // API in production (~150 ms per round trip), so a send costs its
      // number of sequential statements times that. Measured behind a
      // 150 ms-RTT proxy (scripts/loadtest): 7 statements = ~1.1 s per
      // send; the shape below is 2 on the happy path (3 for a duplicate or
      // a stale generation). Same checks, same outcomes, same error codes.
      //
      // One statement for both authorization checks: the caller's device
      // is still active (assertCallerDeviceActive), and the caller is a
      // member. The device check comes first, as before.
      const [access] = await ctx.db
        .select({ revokedAt: devices.revokedAt, memberUserId: conversationMembers.userId })
        .from(devices)
        .leftJoin(
          conversationMembers,
          and(eq(conversationMembers.conversationId, input.conversationId), eq(conversationMembers.userId, ctx.user.id)),
        )
        .where(eq(devices.id, ctx.device.id))
        .limit(1);
      if (!access || access.revokedAt) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This device has been signed out.' });
      }
      if (!access.memberUserId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this conversation.' });
      }

      if (input.messageType === 'welcome' && !input.recipientDeviceId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'recipientDeviceId is required for welcome messages.' });
      }
      if (input.messageType === 'application' && input.recipientDeviceId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Application messages are not addressed to a device.' });
      }
      if (input.messageType === 'welcome') {
        // A group generation comes into existence only through resetGroup,
        // which serializes it. A Welcome sent here could otherwise claim a
        // generation and be joined instead of the one resetGroup accepted —
        // one member diverting the other's devices into a group of its own
        // making. Only app versions from before generations still send
        // Welcomes this way, and only for a conversation still on its first
        // group; those are stored without a generation (read as 1).
        if (input.mlsGeneration !== undefined) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Group Welcomes are sent with resetGroup.' });
        }
        const [conversation] = await ctx.db
          .select({ mlsGeneration: conversations.mlsGeneration })
          .from(conversations)
          .where(eq(conversations.id, input.conversationId))
          .limit(1);
        if (!conversation || conversation.mlsGeneration > 1) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: UPDATE_REQUIRED });
        }
        const [recipient] = await ctx.db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(conversationMembers, eq(conversationMembers.userId, devices.userId))
          .where(
            and(
              eq(conversationMembers.conversationId, input.conversationId),
              eq(devices.id, input.recipientDeviceId!),
              isAddressableDevice(new Date()),
            ),
          )
          .limit(1);
        if (!recipient) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'The recipient must be an active device of a conversation member.' });
        }
      }

      const ciphertext = Buffer.from(input.ciphertext, 'base64');
      // Idempotent for application messages: the same ciphertext sent again
      // (a network-level retry of this request) gets the original row back
      // instead of a second copy, which every receiver would have failed to
      // decrypt. A retry arriving after a group change still resolves to
      // the original (see below). See schema.ts `ciphertextSha256`.
      const ciphertextSha256 = input.messageType === 'application' ? createHash('sha256').update(ciphertext).digest() : null;
      const findOriginal = async () => {
        if (!ciphertextSha256) return undefined;
        const [original] = await ctx.db
          .select({ id: messages.id, createdAt: messages.createdAt })
          .from(messages)
          .where(and(eq(messages.conversationId, input.conversationId), eq(messages.ciphertextSha256, ciphertextSha256)))
          .limit(1);
        return original ? { ...original, duplicate: true } : undefined;
      };

      // Generation check and insert in ONE statement: the row is inserted
      // only if the conversation is still on the generation the message was
      // encrypted in (or, for an app version from before generations, on its
      // first group). FOR SHARE on the conversation row: concurrent sends
      // don't wait for each other, but resetGroup (FOR UPDATE) can't move
      // the generation between this check and the insert — each message
      // lands wholly before or after a group change. (Under READ COMMITTED a
      // row lock wait re-evaluates the WHERE against the committed row, so a
      // send that waited for a reset sees the new generation and inserts
      // nothing.) ON CONFLICT DO NOTHING keeps the idempotency.
      const generationCondition =
        input.mlsGeneration !== undefined
          ? sql`c.mls_generation = ${input.mlsGeneration}::integer`
          : input.messageType === 'application'
            ? sql`c.mls_generation <= 1`
            : sql`true`;
      // A raw statement's timestamptz comes back as text, unlike the query builder's.
      const inserted = await ctx.db.execute<{ id: string; created_at: string | Date }>(sql`
        insert into messages (conversation_id, sender_device_id, recipient_device_id, message_type, ciphertext, ciphertext_sha256, mls_generation)
        select c.id, ${ctx.device.id}::uuid, ${input.recipientDeviceId ?? null}::uuid, ${input.messageType}::message_type,
               ${ciphertext}::bytea, ${ciphertextSha256}::bytea, ${input.mlsGeneration ?? null}::integer
        from conversations c
        where c.id = ${input.conversationId}::uuid and ${generationCondition}
        for share
        on conflict (conversation_id, ciphertext_sha256) do nothing
        returning id, created_at
      `);
      const row = inserted.rows[0];
      // Nothing inserted: an identical send already stored (possibly
      // concurrently, possibly before a group change), or the generation
      // didn't match.
      const message = row ? { id: row.id, createdAt: new Date(row.created_at), duplicate: false } : await findOriginal();

      if (!message) {
        const [conversation] = await ctx.db
          .select({ mlsGeneration: conversations.mlsGeneration })
          .from(conversations)
          .where(eq(conversations.id, input.conversationId))
          .limit(1);
        if (input.mlsGeneration !== undefined && (!conversation || conversation.mlsGeneration !== input.mlsGeneration)) {
          throw new TRPCError({ code: 'CONFLICT', message: STALE_GROUP_GENERATION });
        }
        if (input.messageType === 'application' && conversation && conversation.mlsGeneration > 1) {
          // An app version from before generations, writing into a group
          // this conversation has already replaced: nobody could decrypt
          // it. Refusing makes that version show "failed to send" instead
          // of the other side silently getting an unreadable message.
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: UPDATE_REQUIRED });
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to store message.' });
      }
      if (message.duplicate) {
        // Already stored and announced the first time round.
        ctx.log.info({ conversationId: input.conversationId, messageId: message.id }, 'duplicate send ignored');
        return { messageId: message.id, createdAt: message.createdAt.toISOString() };
      }

      // Content-free "sync now" hint to connected devices, so an open chat
      // doesn't wait for its next poll. Not awaited, like the push below.
      publishConversationUpdated({
        conversationId: input.conversationId,
        senderDeviceId: ctx.device.id,
        recipientDeviceId: input.recipientDeviceId ?? null,
      }).catch((err) => ctx.log.warn({ err }, 'realtime conversation update failed'));

      if (input.messageType === 'application') {
        // Not awaited: a slow or unavailable push provider must never fail or delay the send itself.
        notifyNewMessage({ db: ctx.db, log: ctx.log, conversationId: input.conversationId, senderUserId: ctx.user.id }).catch((err) =>
          ctx.log.warn({ err }, 'push notification fan-out failed'),
        );
      }

      return { messageId: message.id, createdAt: message.createdAt.toISOString() };
    }),

  /**
   * Returns opaque ciphertext rows for a conversation — application
   * messages (any member) plus any 'welcome' messages addressed
   * specifically to the caller's current device. Never returns another
   * device's addressed Welcome.
   */
  fetchMessages: sheddableProcedure.input(fetchMessagesInput).query(async ({ ctx, input }) => {
    // Read-only and legitimately polled at a decent cadence by clients
    // without a push/websocket channel yet — generous ceiling, mainly to
    // blunt scripted hammering rather than shape normal usage. Not
    // gated on device-revocation state (unlike the mutating endpoints
    // above): a revoked device reading ciphertext for conversations it
    // already had access to is materially lower-severity than one still
    // publishing new trust material, and this is the E2EE endpoint most
    // sensitive to added per-call latency.
    enforceRateLimit(`e2ee:fetchMessages:device:${ctx.device.id}`, 120, 60 * 1000);

    const [membership] = await ctx.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, input.conversationId), eq(conversationMembers.userId, ctx.user.id)))
      .limit(1);

    if (!membership) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this conversation.' });
    }

    const visible = or(isNull(messages.recipientDeviceId), eq(messages.recipientDeviceId, ctx.device.id));
    const since = input.sinceCreatedAt ? gte(messages.createdAt, new Date(input.sinceCreatedAt)) : undefined;
    const after = input.page?.after ? PAGE_CURSOR_RE.exec(input.page.after) : null;
    // The plain `>=` is redundant with the row comparison but lets the
    // (conversation_id, created_at) index start the scan at the page.
    const afterCondition = after
      ? and(
          gte(messages.createdAt, sql`${after[1]}::timestamptz`),
          sql`(${messages.createdAt}, ${messages.id}) > (${after[1]}::timestamptz, ${after[2]}::uuid)`,
        )
      : undefined;
    const limit = input.page?.limit ?? LEGACY_MAX_ROWS;
    const columns = {
      id: messages.id,
      senderDeviceId: messages.senderDeviceId,
      senderUserId: devices.userId,
      messageType: messages.messageType,
      ciphertext: messages.ciphertext,
      mlsGeneration: messages.mlsGeneration,
      createdAt: messages.createdAt,
      cursor: rowCursor,
    };

    const rows = await ctx.db
      .select(columns)
      .from(messages)
      .innerJoin(devices, eq(devices.id, messages.senderDeviceId))
      .where(and(eq(messages.conversationId, input.conversationId), visible, since, afterCondition))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);

    // A full page leaves newer rows for later pages, and with them perhaps
    // the newest Welcome addressed to this device. Without that Welcome the
    // device would take older-generation messages for a group it isn't in
    // and rebuild the conversation's group needlessly (see groupSync's
    // planRow) — so its Welcomes past the page always come along, marked
    // `outOfPage`: a device has one per generation, so they stay few. Paged
    // callers only; older app versions would take their timestamps as their
    // sync position and skip the rows in between.
    const lastPosition = rows.length === limit ? PAGE_CURSOR_RE.exec(rows[rows.length - 1]?.cursor ?? '') : null;
    const laterWelcomes =
      input.page && lastPosition
        ? await ctx.db
            .select(columns)
            .from(messages)
            .innerJoin(devices, eq(devices.id, messages.senderDeviceId))
            .where(
              and(
                eq(messages.conversationId, input.conversationId),
                eq(messages.messageType, 'welcome'),
                eq(messages.recipientDeviceId, ctx.device.id),
                gte(messages.createdAt, sql`${lastPosition[1]}::timestamptz`),
                sql`(${messages.createdAt}, ${messages.id}) > (${lastPosition[1]}::timestamptz, ${lastPosition[2]}::uuid)`,
              ),
            )
            .orderBy(asc(messages.createdAt), asc(messages.id))
        : [];

    const toWire = (row: (typeof rows)[number], outOfPage: boolean) => ({
      id: row.id,
      senderDeviceId: row.senderDeviceId,
      // Lets a device tell its own account's other devices' messages apart
      // from the other member's. Additive; older clients ignore it.
      senderUserId: row.senderUserId,
      messageType: row.messageType,
      ciphertext: row.ciphertext.toString('base64'),
      // Rows written before generations existed all belong to generation 1.
      mlsGeneration: row.mlsGeneration ?? 1,
      createdAt: row.createdAt.toISOString(),
      // Exact position for the next page's `after`.
      cursor: row.cursor,
      ...(outOfPage ? { outOfPage: true as const } : {}),
    });
    return [...rows.map((row) => toWire(row, false)), ...laterWelcomes.map((row) => toWire(row, true))];
  }),

  /**
   * Lists a user's active AND E2EE-ready device IDs — needed to address a
   * KeyPackage/Welcome request. Returns IDs only, no other device metadata.
   *
   * Bug fix: this previously filtered only on `revokedAt IS NULL`, so a
   * device that exists (created at login/register) but never finished
   * `registerDeviceCredential` — because its `ensureE2eeSetup` is still
   * in flight, failed, or (on web, where the native MLS module is
   * unavailable) can never run — was still reported as an addressable
   * target. `consumeKeyPackage` would then correctly find no KeyPackage
   * for it, and if that happened to be the caller's only candidate
   * device, `startConversation` failed with "isn't ready to receive
   * encrypted messages yet" even when the recipient had a genuinely
   * ready device that just wasn't the one considered. Requiring
   * `mlsCredentialPublicKey IS NOT NULL` here restricts this list to
   * devices that have actually completed credential registration, which
   * is the real precondition for being a valid KeyPackage/Welcome target.
   */
  listActiveDeviceIds: protectedProcedure.input(z.object({ userId: z.string().uuid() })).query(async ({ ctx, input }) => {
    // Read-only, but this is a per-user device-enumeration primitive —
    // bounded generously enough for legitimate group-membership checks
    // (which may look up several users in a row) while blunting scripted
    // enumeration of many users' device lists.
    enforceRateLimit(`e2ee:listActiveDeviceIds:device:${ctx.device.id}`, 60, 5 * 60 * 1000);
    // Only for oneself or a conversation partner (app versions from before
    // listConversationDevices use it right after createConversation).
    if (!(await sharesConversationOrSelf(ctx, input.userId))) return [];

    const rows = await ctx.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.userId, input.userId), isAddressableDevice(new Date())));
    return rows.map((r) => r.id);
  }),

  /**
   * Every addressable device (see isAddressableDevice) of every member of a
   * conversation, with its MLS credential key — what a device needs to
   * build the conversation's group for all of them, and to notice a device
   * that has since signed out but is still in the group. Public keys only;
   * members already learn each other's credentials from the group itself.
   */
  listConversationDevices: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      enforceRateLimit(`e2ee:listConversationDevices:device:${ctx.device.id}`, 120, 5 * 60 * 1000);
      await assertMember(ctx, input.conversationId);

      const rows = await ctx.db
        .select({ deviceId: devices.id, userId: devices.userId, credentialPublicKey: devices.mlsCredentialPublicKey })
        .from(devices)
        .innerJoin(conversationMembers, eq(conversationMembers.userId, devices.userId))
        .where(and(eq(conversationMembers.conversationId, input.conversationId), isAddressableDevice(new Date())));

      return rows.flatMap((row) =>
        row.credentialPublicKey
          ? [{ deviceId: row.deviceId, userId: row.userId, credentialPublicKey: row.credentialPublicKey.toString('base64') }]
          : [],
      );
    }),

  /**
   * How many usable KeyPackages this device still has published. The app
   * tops the pool up when this runs low — it used to publish one batch per
   * device, ever, so a device that had been added to enough conversations
   * (or failed attempts) could never be added to another one.
   */
  keyPackageStatus: sheddableProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ available: sql<number>`count(*)::int` })
      .from(deviceKeyPackages)
      .where(
        and(
          eq(deviceKeyPackages.deviceId, ctx.device.id),
          gt(deviceKeyPackages.createdAt, new Date(Date.now() - KEY_PACKAGE_MAX_AGE_MS)),
        ),
      );
    return { available: row?.available ?? 0 };
  }),

  /**
   * Establishes the conversation's MLS group — for the first time, or
   * again — as the next generation: one Welcome (from a single commit that
   * adds every device, see mls-core's rebuild_group) stored for each
   * device that was included.
   *
   * This is the only way a group comes into existence, and it is
   * serialized: the conversation row is locked and `expectedGeneration`
   * must still be current, so of two devices racing to set up (or repair)
   * the same conversation exactly one wins; the other gets `{ ok: false }`
   * with the current generation and joins the winner's group from its
   * Welcome. That race used to leave a chat's two members in two different
   * groups for good.
   *
   * A device rebuilds when the group is unusable for it: never set up, a
   * stale or forked copy, a device of either member that isn't in it yet,
   * or a signed-out device still in it (so an ended session stops being
   * able to decrypt new messages). Every generation is a fresh MLS group
   * with fresh keys; nothing about MLS itself changes.
   */
  resetGroup: protectedProcedure
    .input(
      z.object({
        conversationId: z.string().uuid(),
        expectedGeneration: z.number().int().min(0),
        welcome: base64Bytes,
        recipientDeviceIds: z.array(z.string().uuid()).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`e2ee:resetGroup:device:${ctx.device.id}`, 30, 60 * 60 * 1000);
      await assertCallerDeviceActive(ctx);
      await assertMember(ctx, input.conversationId);

      const recipientDeviceIds = [...new Set(input.recipientDeviceIds)];
      if (recipientDeviceIds.includes(ctx.device.id)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A device does not send itself a Welcome.' });
      }

      // Fault injection for local multi-device test runs only (no-op in production) — see lib/testHooks.ts.
      if (resetGroupTestDelayMs() > 0) {
        ctx.log.warn({ delayMs: resetGroupTestDelayMs() }, 'TEST HOOK: delaying resetGroup');
        await new Promise((resolve) => setTimeout(resolve, resetGroupTestDelayMs()));
      }

      const result = await ctx.db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ mlsGeneration: conversations.mlsGeneration, builtBy: conversations.mlsGenerationDeviceId })
          .from(conversations)
          .where(eq(conversations.id, input.conversationId))
          .for('update');
        if (!conversation) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' });
        }
        if (conversation.mlsGeneration !== input.expectedGeneration) {
          // `builtByThisDevice`: a retry of a call whose response was lost
          // finds out that its first attempt is the one that went through.
          return {
            ok: false as const,
            generation: conversation.mlsGeneration,
            builtByThisDevice: conversation.builtBy === ctx.device.id,
          };
        }

        // Welcomes only go to addressable devices of this conversation's members.
        const allowed = await tx
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(conversationMembers, eq(conversationMembers.userId, devices.userId))
          .where(
            and(
              eq(conversationMembers.conversationId, input.conversationId),
              inArray(devices.id, recipientDeviceIds),
              isAddressableDevice(new Date()),
            ),
          );
        if (allowed.length !== recipientDeviceIds.length) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Every recipient must be an active device of a conversation member.' });
        }

        const generation = conversation.mlsGeneration + 1;
        const welcome = Buffer.from(input.welcome, 'base64');
        await tx.insert(messages).values(
          recipientDeviceIds.map((recipientDeviceId) => ({
            conversationId: input.conversationId,
            senderDeviceId: ctx.device.id,
            recipientDeviceId,
            messageType: 'welcome' as const,
            ciphertext: welcome,
            mlsGeneration: generation,
          })),
        );
        await tx
          .update(conversations)
          .set({ mlsGeneration: generation, mlsGenerationDeviceId: ctx.device.id })
          .where(eq(conversations.id, input.conversationId));
        return { ok: true as const, generation };
      });

      if (result.ok && takeDroppedResetResponse()) {
        // The group IS established; only the answer is lost (see lib/testHooks.ts).
        ctx.log.warn({ conversationId: input.conversationId, generation: result.generation }, 'TEST HOOK: dropping resetGroup response');
        ctx.res.raw.socket?.destroy();
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'TEST HOOK: response dropped' });
      }
      if (result.ok) {
        ctx.log.info(
          { conversationId: input.conversationId, generation: result.generation, recipients: recipientDeviceIds.length },
          'conversation group established',
        );
        publishConversationUpdated({ conversationId: input.conversationId, senderDeviceId: ctx.device.id, recipientDeviceId: null }).catch(
          (err) => ctx.log.warn({ err }, 'realtime conversation update failed'),
        );
      }
      return result;
    }),
});
