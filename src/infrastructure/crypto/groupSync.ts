/**
 * The decisions that keep this device on a conversation's current MLS
 * group — which Welcome to join, what to do with each fetched row, and
 * when this device has to rebuild the group for everyone. Pure: no React
 * Native, native-module or storage imports, so every rule here is unit
 * tested (groupSync.test.ts); ChatContext only carries them out.
 *
 * Background — why "Unable to decrypt this message" happened:
 *
 * - Starting a chat added each of the other person's devices with its own
 *   commit and never delivered those commits, so every device but the last
 *   one added was left on an epoch no one else used.
 * - Both people starting the same chat before either had processed the
 *   other's Welcome produced two different groups with the same id; the
 *   second Welcome was rejected ("group already exists") and the error was
 *   swallowed.
 * - A device added later (a new phone, signing in again) or a device that
 *   lost its group state had no way to (re)join, and a signed-out device
 *   was never removed.
 *
 * The fix: a conversation's group only ever changes by being rebuilt as a
 * whole — one commit adding every active device, one Welcome for all of
 * them — as a numbered "generation" that the server serializes (see the
 * server's e2ee.resetGroup). A device that finds itself outside the
 * current generation, or unable to read it, rebuilds; everyone else joins
 * the new generation from its Welcome. MLS itself is unchanged: every
 * generation is an ordinary MLS group with fresh keys.
 */

/** What a failed mls-core call means for the caller (see rust/src/error.rs). */
export type MlsFailure =
  /** This device's copy of the group is behind: it can never read this; rebuild. */
  | 'future_epoch'
  /** Sent before this device joined (MLS gives new members no older keys, by design). */
  | 'past_epoch'
  /** Our own message — MLS erases the key right after sending. */
  | 'own_message'
  /**
   * A second copy of a message this device already decrypted (the same send
   * reached the server twice). Skipped silently: the first copy is shown.
   */
  | 'duplicate'
  /** No local copy of the group. */
  | 'no_group'
  /** Failed authentication: tampered, or from a different group with the same id. */
  | 'invalid'
  /** Anything else (storage not open yet, I/O): worth retrying as is. */
  | 'transient';

/**
 * The native module reports the Rust error variant's name as the message
 * (MlsCoreModule.kt's MlsCoreRuntimeError), e.g. "InvalidCiphertext".
 */
export function classifyMlsError(err: unknown): MlsFailure {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (text.includes('DuplicateMessage')) return 'duplicate';
  if (text.includes('MessageFromFutureEpoch')) return 'future_epoch';
  if (text.includes('MessageFromPastEpoch')) return 'past_epoch';
  if (text.includes('OwnMessage')) return 'own_message';
  if (text.includes('GroupNotFound')) return 'no_group';
  if (text.includes('InvalidCiphertext')) return 'invalid';
  return 'transient';
}

/**
 * A Welcome that can't be joined: permanently (not for one of this
 * device's KeyPackages, malformed, already used) — stop trying it — or
 * transiently (storage) — try again on the next sync.
 */
export function isPermanentWelcomeFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return text.includes('InvalidInput') || text.includes('GroupOperationFailed');
}

export interface SyncRow {
  id: string;
  messageType: 'application' | 'welcome';
  /** The generation the row belongs to (rows from older servers are 1). */
  mlsGeneration: number;
}

/**
 * Rows in the order they must be processed: by generation, and within a
 * generation the Welcome first, otherwise in server order. Every message
 * of an old group is read with that group before this device moves to a
 * newer one — a send racing a group change can be stamped a moment after
 * the new Welcome, and would otherwise arrive after the old group is gone.
 */
export function orderForSync<T extends SyncRow>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        a.row.mlsGeneration - b.row.mlsGeneration ||
        (a.row.messageType === 'welcome' ? 0 : 1) - (b.row.messageType === 'welcome' ? 0 : 1) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/**
 * The one Welcome worth joining: the newest generation above the one this
 * device holds. Older Welcomes are for groups already replaced.
 */
export function pickWelcome<T extends SyncRow>(rows: readonly T[], localGeneration: number, isProcessed: (row: T) => boolean): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (row.messageType !== 'welcome' || row.mlsGeneration <= localGeneration || isProcessed(row)) continue;
    if (!best || row.mlsGeneration > best.mlsGeneration) best = row;
  }
  return best;
}

export type RowAction =
  /** Join this Welcome. */
  | 'join'
  /** A Welcome for a replaced group, or one already handled. */
  | 'skip_welcome'
  /** Stored already (decrypted, or recorded as unreadable). */
  | 'already_stored'
  /** From a group this device never had or has left: can never be read here. */
  | 'old_generation'
  /** From a newer group this device isn't in (yet): stop here and rebuild. */
  | 'not_member'
  /** Sent by this very device but missing locally (e.g. app data cleared). */
  | 'own_message_lost'
  | 'decrypt';

export function planRow(
  row: SyncRow & { senderDeviceId: string },
  state: {
    localGeneration: number;
    /** Generation of the Welcome this sync will join, if any. */
    targetGeneration: number;
    welcomeToJoinId: string | null;
    ownDeviceId: string;
    stored: boolean;
  },
): RowAction {
  if (row.messageType === 'welcome') {
    return row.id === state.welcomeToJoinId ? 'join' : 'skip_welcome';
  }
  if (state.stored) return 'already_stored';
  if (row.senderDeviceId === state.ownDeviceId) return 'own_message_lost';
  if (state.localGeneration > 0 && row.mlsGeneration === state.localGeneration) return 'decrypt';
  if (row.mlsGeneration < Math.max(state.localGeneration, state.targetGeneration)) return 'old_generation';
  return 'not_member';
}

/** Whether a message came from this account (this or another of its devices). */
export function isFromOwnAccount(row: { senderDeviceId: string; senderUserId?: string | null }, own: { deviceId: string; userId: string }): boolean {
  return row.senderDeviceId === own.deviceId || (row.senderUserId != null && row.senderUserId === own.userId);
}

/**
 * Whether a sync saw evidence that this device's copy of the group is
 * unusable. A message it couldn't read only counts if it belongs to the
 * generation the device is on after the sync: a failure in a group the
 * device has since left (it joined a newer Welcome later in the same sync)
 * says nothing about the current one. Acting on such stale evidence made
 * devices rebuild a group that was already fine, forcing everyone to rejoin
 * again.
 */
export function sawUnusableGroup(state: { notMember: boolean; failedGenerations: readonly number[]; localGeneration: number }): boolean {
  return state.notMember || state.failedGenerations.includes(state.localGeneration);
}

export type RebuildReason =
  /** Nobody has set the group up yet. */
  | 'no_group_yet'
  /** The conversation moved to a group this device wasn't included in (e.g. a new device, or one without KeyPackages then). */
  | 'not_in_current_group'
  /** This device's copy can't read the others' messages: stale or forked. */
  | 'unreadable'
  /** A device that has signed out is still a member and could read new messages. */
  | 'signed_out_member';

export function rebuildReason(state: {
  serverGeneration: number;
  localGeneration: number;
  /** A message in the current generation failed with future_epoch/invalid/no_group. */
  unreadable: boolean;
  signedOutMembers: number;
}): RebuildReason | null {
  if (state.serverGeneration === 0) return 'no_group_yet';
  if (state.localGeneration < state.serverGeneration) return 'not_in_current_group';
  if (state.unreadable) return 'unreadable';
  if (state.signedOutMembers > 0) return 'signed_out_member';
  return null;
}

/**
 * Minimum time between two automatic rebuilds of one conversation by one
 * device. A rebuild makes every other device rejoin, so a device that keeps
 * seeing unreadable data (e.g. a server replaying garbage) must not turn
 * that into a rebuild storm. A user starting a chat bypasses it.
 */
export const REBUILD_COOLDOWN_MS = 60 * 1000;

export function mayRebuildNow(lastAttemptAt: number | undefined, now: number, userInitiated: boolean): boolean {
  return userInitiated || lastAttemptAt === undefined || now - lastAttemptAt >= REBUILD_COOLDOWN_MS;
}

/** Base64 credential keys of group members that aren't any active device's key: signed-out devices still in the group. */
export function signedOutMemberKeys(groupMemberKeys: readonly string[], activeDeviceKeys: readonly string[]): string[] {
  const active = new Set(activeDeviceKeys);
  return groupMemberKeys.filter((key) => !active.has(key));
}

export interface ConversationDevice {
  deviceId: string;
  userId: string;
  credentialPublicKey: string;
}

/**
 * The devices a rebuild adds: every active device of every member except
 * this install (its own row, and any older server row for the same install
 * — same credential key — which is the same leaf).
 */
export function rebuildTargets(devices: readonly ConversationDevice[], self: { deviceId: string; credentialPublicKey: string }): ConversationDevice[] {
  return devices.filter((device) => device.deviceId !== self.deviceId && device.credentialPublicKey !== self.credentialPublicKey);
}

/**
 * A rebuild must reach at least one device of every other member —
 * otherwise it would lock that person out of the conversation instead of
 * repairing it. This account's own other devices are welcome but optional.
 */
export function coversOtherMembers(includedUserIds: readonly string[], memberUserIds: readonly string[], ownUserId: string): boolean {
  const included = new Set(includedUserIds);
  return memberUserIds.every((userId) => userId === ownUserId || included.has(userId));
}

export type RebuildResponse = { ok: true; generation: number } | { ok: false; generation: number; builtByThisDevice?: boolean };

/**
 * Whether this device's rebuild is the one the server kept. A retry after a
 * lost response comes back "not ok", but names this device as the builder
 * of exactly the generation it asked for.
 */
export function rebuildWasAccepted(response: RebuildResponse, expectedGeneration: number): boolean {
  if (response.ok) return true;
  return response.builtByThisDevice === true && response.generation === expectedGeneration + 1;
}

/** The server refused a send because the conversation moved to another group since it was encrypted. */
export function isStaleGenerationError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes('STALE_GROUP_GENERATION');
}
