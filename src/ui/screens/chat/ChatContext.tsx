import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import type { Conversation } from '@/domain/entities';
import { base64ToBytes, bytesToBase64 } from '@/infrastructure/crypto/base64';
import {
  coversOtherMembers,
  classifyMlsError,
  findPendingSendForRow,
  isFromOwnAccount,
  isPermanentWelcomeFailure,
  isStaleGenerationError,
  mayRebuildNow,
  orderForSync,
  pickWelcome,
  planRow,
  rebuildReason,
  rebuildStillApplies,
  rebuildTargets,
  rebuildWasAccepted,
  resolveRebuildCandidate,
  sawUnusableGroup,
  signedOutMemberKeys,
  type ConversationDevice,
} from '@/infrastructure/crypto/groupSync';
import {
  ackDecrypted,
  decryptMessageOnce,
  deleteGroup,
  encryptMessage,
  ensureMlsCoreInitialized,
  generateBlobKey,
  generateDeviceCredential,
  generateIdentityKey,
  generateKeyPackages,
  groupMemberSignatureKeys,
  joinGroupReplacing,
  openBlob,
  pendingDecryptedIds,
  rebuildGroup,
  sealBlob,
} from '@/infrastructure/crypto/mlsCore';
import { uuidToBytes } from '@/infrastructure/crypto/uuid';
import { buildVoiceEnvelope, parseVoiceEnvelope } from '@/infrastructure/media/voiceEnvelope';
import { nextPollDelayMs } from '@/infrastructure/network/pollSchedule';
import { backoffDelayMs, isRetryableApiFailure } from '@/infrastructure/network/transientFailures';
import { e2eeApi, getApiErrorMessage, usersApi } from '@/infrastructure/network/trpcClient';
import { downloadVoiceBlob, uploadVoiceBlob } from '@/infrastructure/network/voiceMediaApi';
import {
  clearRebuildCandidate,
  deleteAppState,
  downloadedVoiceMediaIds,
  failInterruptedSends,
  getAppState,
  getConversation,
  getLocalGroupGeneration,
  getMessageById,
  getMessageStoreOwner,
  getRebuildCandidate,
  getStoredMessageStates,
  getSyncCursor,
  initMessageStore,
  listLocalConversations,
  listPendingOutgoingIds,
  reconcileSentMessageId,
  recordMessage,
  refreshConversationPreview,
  resetInterruptedVoiceDownloads,
  setAppState,
  setLocalGroupGeneration,
  setMessageStoreOwner,
  setRebuildCandidate,
  setSyncCursor,
  setVoiceBlob,
  updateMessageCreatedAt,
  updateMessageStatus,
  updateVoiceAudio,
  upsertConversation,
} from '@/infrastructure/storage/messageStore';
import { presentNewMessageNotification } from '@/infrastructure/notifications/pushNotifications';
import { realtime } from '@/infrastructure/realtime/realtimeClient';
import { persistRecording, readAudioBytes, writeDownloadedAudio } from '@/infrastructure/storage/voiceFiles';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { useNotifications } from '@/ui/screens/settings/NotificationsProvider';
import { notifyConversationChanged } from './conversationMessages';

const KEY_PACKAGE_BATCH_SIZE = 20;
/**
 * Below this many published KeyPackages, setup publishes another batch.
 * Every conversation (re)built with this device in it uses one; the pool
 * used to be published once per device and never refilled, so a device
 * eventually became impossible to add to any conversation.
 */
const KEY_PACKAGE_LOW_WATER = 10;
/** The first wait between chat-list polls while the realtime socket is down; each quiet poll doubles it (see pollSchedule.ts). */
const CONVERSATIONS_POLL_MS = 6000;
/** The wait with the socket connected (changes arrive as hints instead), and the cap while it is down. */
const ONLINE_POLL_MS = 30_000;
/** How often a conversation's group membership is compared with its members' signed-in devices. */
const MEMBERSHIP_CHECK_MS = 5 * 60 * 1000;

/**
 * How far before the newest already-processed message an incremental sync
 * starts reading again. A row is timestamped when its insert starts, so a
 * row that commits a moment after a later-stamped one could otherwise land
 * behind the cursor; anything re-read inside this window is skipped by id.
 */
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
/** Rows per fetchMessages page while syncing (the server allows up to 500). */
const SYNC_PAGE_ROWS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function randomLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const pendingCiphertextKey = (owner: string, localId: string) => `pendingCiphertext:${owner}:${localId}`;

/** The id a voice clip's blob is decrypted under (see decryptMessageOnce) — distinct from any message row id. */
const voiceBlobRowId = (mediaId: string) => `media:${mediaId}`;

/**
 * Tidies up after the app was killed while receiving (see
 * decryptMessageOnce): kept plaintext of rows that did get stored is
 * dropped, and voice downloads left half-done can be retried. Rows that were
 * decrypted but not stored keep their plaintext; the next sync stores them.
 * Local only, so it also runs offline. Best effort: it never blocks setup.
 */
async function recoverInterruptedReceives(owner: string): Promise<void> {
  try {
    if (getMessageStoreOwner() !== owner) return;
    resetInterruptedVoiceDownloads(owner);
    const pending = await pendingDecryptedIds(owner);
    if (pending.length === 0 || getMessageStoreOwner() !== owner) return;
    const rowIds = pending.filter((id) => !id.startsWith('media:'));
    const mediaIds = pending.filter((id) => id.startsWith('media:')).map((id) => id.slice('media:'.length));
    const storedRows = getStoredMessageStates(owner, rowIds);
    const storedMedia = downloadedVoiceMediaIds(owner, mediaIds);
    const done = [...rowIds.filter((id) => storedRows.has(id)), ...mediaIds.filter((id) => storedMedia.has(id)).map(voiceBlobRowId)];
    await ackDecrypted(owner, done);
  } catch {
    // Nothing here is needed for messaging to work; the next start retries.
  }
}

/** The ciphertext an unconfirmed send sealed, and the generation it was sealed for (see sealOnce). */
function readPendingCiphertext(owner: string, localId: string): { generation: number; ciphertext: string } | null {
  const saved = getAppState(pendingCiphertextKey(owner, localId));
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as { generation?: unknown; ciphertext?: unknown };
    if (typeof parsed.generation === 'number' && typeof parsed.ciphertext === 'string') {
      return { generation: parsed.generation, ciphertext: parsed.ciphertext };
    }
  } catch {
    // unreadable: as good as none
  }
  return null;
}

/**
 * The ciphertext to send for one outgoing message in `generation`: the one
 * its first attempt encrypted, when there is one for that generation. A
 * send whose response was lost (a timeout, a dropped connection) may well
 * have been stored; sending the very same bytes again lets the server's
 * duplicate check (see e2ee.sendMessage) answer with that original message
 * instead of storing a second copy, which the other side would get twice.
 * Re-encrypting is only right once the group has changed, which refused the
 * old ciphertext anyway. Cleared when the send is confirmed.
 */
async function sealOnce(owner: string, localId: string, generation: number, encrypt: () => Promise<Uint8Array>): Promise<string> {
  const saved = readPendingCiphertext(owner, localId);
  if (saved && saved.generation === generation) return saved.ciphertext;
  const ciphertext = bytesToBase64(await encrypt());
  if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
  setAppState(pendingCiphertextKey(owner, localId), JSON.stringify({ generation, ciphertext }));
  return ciphertext;
}

/** The conversation's group changed between a send reading its generation and encrypting; the send starts over (see encryptAndSend). */
class GroupChangedError extends Error {
  constructor() {
    super('The conversation changed while this message was being prepared.');
  }
}

/**
 * `encryptMessage` for a send tagged `generation`, refused if the local
 * generation no longer reads `generation` at the moment the native call is
 * dispatched. A send reads the generation, then may await (a voice clip's
 * upload) before encrypting; a rebuild or join in between replaces the
 * native group, and encrypting then would produce bytes tagged with one
 * generation but readable only in another — which every other device
 * records as "Unable to decrypt", for good. The native module runs calls
 * in dispatch order, so a call dispatched while the label still reads
 * `generation` encrypts with that generation's group.
 */
async function encryptForGeneration(owner: string, conversationId: string, generation: number, plaintext: string): Promise<Uint8Array> {
  if (getLocalGroupGeneration(owner, conversationId) !== generation) throw new GroupChangedError();
  return encryptMessage(owner, uuidToBytes(conversationId), plaintext);
}

/** Delays between automatic retries of a send that failed for a passing reason (no answer, timeout, 5xx, rate limit); jittered. */
const SEND_RETRY_BASE_MS = 2000;
const SEND_RETRY_CAP_MS = 8000;
const SEND_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameConversationList(a: Conversation[], b: Conversation[]): boolean {
  return (
    a.length === b.length &&
    a.every((conversation, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        conversation.id === other.id &&
        conversation.otherUserId === other.otherUserId &&
        conversation.otherUsername === other.otherUsername &&
        conversation.otherDisplayName === other.otherDisplayName &&
        conversation.groupJoined === other.groupJoined &&
        conversation.lastMessagePreview === other.lastMessagePreview &&
        conversation.lastMessageAt === other.lastMessageAt &&
        conversation.createdAt === other.createdAt
      );
    })
  );
}

/** A group (re)build that couldn't include the other person: they have no device ready to receive encrypted messages. */
class PeerNotReadyError extends Error {}

interface UserSearchResult {
  id: string;
  username: string;
  displayName: string;
  avatarId: string | null;
}

interface ChatContextValue {
  conversations: Conversation[];
  e2eeReady: boolean;
  e2eeError: string | null;
  retryE2eeSetup(): Promise<void>;
  refreshConversations(): Promise<void>;
  startConversation(otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string>;
  pollConversation(conversationId: string): Promise<void>;
  sendChatMessage(conversationId: string, text: string): Promise<void>;
  sendVoiceMessage(conversationId: string, localFileUri: string, durationMs: number): Promise<void>;
  downloadVoiceMessage(conversationId: string, messageId: string): Promise<void>;
  retryMessage(conversationId: string, messageId: string): Promise<void>;
  searchUsers(query: string): Promise<UserSearchResult[]>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { status, deviceId, user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [e2eeReady, setE2eeReady] = useState(false);
  const [e2eeError, setE2eeError] = useState<string | null>(null);

  // The list is re-read from SQLite on every sync; only a real change should
  // re-render the screens showing it. Message changes don't go through
  // provider state at all — see conversationMessages.ts.
  const applyConversations = useCallback((next: Conversation[]) => {
    setConversations((current) => (sameConversationList(current, next) ? current : next));
  }, []);

  // Read inside pollConversation without widening its dependencies. Messages
  // created before this session started are never announced, so opening the
  // app (or a first sync after reinstall) doesn't replay old notifications.
  const { shouldPresentLocally } = useNotifications();
  const notifyContextRef = useRef({ shouldPresentLocally, conversations, sessionStartedAt: Date.now() });
  notifyContextRef.current.shouldPresentLocally = shouldPresentLocally;
  notifyContextRef.current.conversations = conversations;

  /**
   * Per-conversation group bookkeeping that doesn't need to survive a
   * restart: the server's current generation as last seen (listConversations,
   * createConversation, resetGroup and sync all refresh it), when this device
   * last tried to rebuild each group, and when it last compared a group's
   * members with the server's signed-in devices.
   */
  const serverGenerationRef = useRef(new Map<string, number>());
  const lastRebuildAtRef = useRef(new Map<string, number>());
  const membershipCheckedAtRef = useRef(new Map<string, number>());
  /** This install's MLS credential key (base64) — how it recognises its own entry in the server's device lists. */
  const ownCredentialKeyRef = useRef<string | null>(null);

  useEffect(() => {
    initMessageStore();
  }, []);

  // Points the local SQLite cache at whichever account is currently
  // authenticated (or at no account, on logout) — declared before the
  // effects below so it always runs first within the same commit when
  // `user`/`status` change together (login and logout both flip both in
  // one AuthContext state update). Every messageStore read/write below
  // captures this value with `getMessageStoreOwner()` at the start of
  // its own operation and threads that SAME captured value through every
  // store call it makes — see messageStore's module doc for why: a
  // request started under one account must never write under whichever
  // account happens to be live by the time that request resolves.
  useEffect(() => {
    setMessageStoreOwner(user?.id ?? null);
    serverGenerationRef.current.clear();
    lastRebuildAtRef.current.clear();
    membershipCheckedAtRef.current.clear();
    ownCredentialKeyRef.current = null;
  }, [user?.id]);

  /**
   * Keeps this device's published KeyPackage pool from running dry — each
   * conversation (re)built with this device in it consumes one, and an
   * empty pool makes the device impossible to add. Replaces a local
   * "published once" flag that never refilled the pool.
   */
  const topUpKeyPackages = useCallback(async (): Promise<void> => {
    const { available } = await e2eeApi.keyPackageStatus();
    if (available >= KEY_PACKAGE_LOW_WATER) return;
    const keyPackages = await generateKeyPackages(KEY_PACKAGE_BATCH_SIZE);
    await e2eeApi.publishKeyPackages({ keyPackages: keyPackages.map(bytesToBase64) });
  }, []);

  /**
   * Runs once per authenticated session: identity key, device credential,
   * and a KeyPackage top-up, all idempotent (generateIdentityKey/
   * generateDeviceCredential no-op if already set locally,
   * registerIdentityKey/registerDeviceCredential no-op if already set
   * server-side, and the top-up only publishes when the server reports the
   * pool running low).
   *
   * Reentrancy guard (`inFlightRef`): this is invoked from a `useEffect`
   * keyed on `[status, ensureE2eeSetup]`, and again from the UI's retry
   * action — both of those can fire while a previous call is still
   * awaiting `ensureMlsCoreInitialized`/`generateIdentityKey`/network
   * round-trips. Without this guard, two overlapping calls would each
   * independently call the native module — every native call here
   * requires the account's local MLS storage to already be open (see
   * mls-core's `requireInitialized()`/`StorageNotInitialized`), and nothing
   * about a single in-flight call gives a *second*, independent call any
   * stronger guarantee about exactly when that storage finishes opening.
   * Deduplicating to a single shared in-flight promise (cleared on
   * settle, so a genuine retry after failure starts fresh) guarantees
   * there is only ever one native setup sequence running at a time — the
   * only way to *guarantee*, rather than hope, that storage
   * initialization is complete before any `generateIdentityKey()` call.
   */
  const inFlightRef = useRef<Promise<void> | null>(null);
  /** Sends the app was killed in the middle of, found at startup and resent once E2EE is ready (see failInterruptedSends). */
  const interruptedSendsRef = useRef<{ id: string; conversationId: string }[]>([]);
  const sendsRecoveredForRef = useRef(new Set<string>());

  const ensureE2eeSetup = useCallback((): Promise<void> => {
    if (!deviceId || !user) return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;

    const run = async () => {
      try {
        await ensureMlsCoreInitialized(user.id);
        await recoverInterruptedReceives(user.id);
        // Once per account per app start, before anything can be sending.
        if (!sendsRecoveredForRef.current.has(user.id) && getMessageStoreOwner() === user.id) {
          sendsRecoveredForRef.current.add(user.id);
          interruptedSendsRef.current = failInterruptedSends(user.id);
        }

        const identity = await generateIdentityKey();
        const credential = await generateDeviceCredential();
        // Both registrations are set-once on the server, so once this
        // login's device row has them there is nothing to send again. They
        // used to be sent on every launch, and each counts against a small
        // per-device budget — an app restarted a few times in an hour was
        // refused with "Too many attempts" and lost encrypted messaging
        // until the window passed. The flag is per device row (a new login
        // is a new row, which must register again) and only set after the
        // server accepted both.
        const registeredKey = `e2eeRegistered:${user.id}:${deviceId}`;
        if (getAppState(registeredKey) !== '1') {
          await e2eeApi.registerIdentityKey({ publicKey: bytesToBase64(identity.publicKey) });
          await e2eeApi.registerDeviceCredential({
            credentialPublicKey: bytesToBase64(credential.credentialPublicKey),
            crossSignature: bytesToBase64(credential.crossSignature),
          });
          if (getMessageStoreOwner() === user.id) setAppState(registeredKey, '1');
        }
        ownCredentialKeyRef.current = bytesToBase64(credential.credentialPublicKey);

        await topUpKeyPackages();

        setE2eeError(null);
        setE2eeReady(true);
      } catch (err) {
        setE2eeReady(false);
        setE2eeError(getApiErrorMessage(err, 'Could not set up encrypted messaging on this device.'));
      } finally {
        inFlightRef.current = null;
      }
    };

    const promise = run();
    inFlightRef.current = promise;
    return promise;
  }, [deviceId, user, topUpKeyPackages]);

  /**
   * Fetches and opens a received voice message's audio blob and caches the
   * audio to a local file. The blob is sealed under the content key its
   * envelope carried (see voiceEnvelope.ts / rust/src/blob.rs), so when it
   * is fetched doesn't matter: right after the envelope (what
   * `syncConversation` does), or whenever the user taps a message whose
   * audio couldn't be fetched then (offline). A message already downloading
   * or downloaded is left alone.
   *
   * Legacy: a clip from an app version before content keys has no key; it
   * is MLS ciphertext from the same sender, decryptable only through the
   * group and only while the sender's key is still kept (MLS keeps a few
   * skipped keys per sender, none once the conversation moves to a newer
   * group). Decrypting one twice is not possible, hence decryptMessageOnce.
   */
  const fetchVoiceAudio = useCallback(async (owner: string, conversationId: string, messageId: string): Promise<void> => {
    const row = getMessageById(owner, messageId);
    if (!row || row.kind !== 'voice' || !row.audioMediaId) return;
    if (row.audioState === 'downloading' || row.audioState === 'downloaded') return;

    updateVoiceAudio(owner, messageId, { audioState: 'downloading' });
    notifyConversationChanged(conversationId);

    try {
      const blobCiphertext = await downloadVoiceBlob(conversationId, row.audioMediaId);
      if (getMessageStoreOwner() !== owner) return;
      let audio: Uint8Array;
      let legacyRowId: string | null = null;
      if (row.audioKey) {
        audio = await openBlob(base64ToBytes(row.audioKey), blobCiphertext);
      } else {
        // Crash-safe like the messages themselves (see syncConversation): a
        // download interrupted after decrypting can decrypt again.
        legacyRowId = voiceBlobRowId(row.audioMediaId);
        audio = base64ToBytes(await decryptMessageOnce(owner, uuidToBytes(conversationId), legacyRowId, blobCiphertext));
      }
      if (getMessageStoreOwner() !== owner) return;
      const uri = writeDownloadedAudio(owner, conversationId, row.audioMediaId, audio);
      if (getMessageStoreOwner() !== owner) return;
      updateVoiceAudio(owner, messageId, { audioLocalUri: uri, audioState: 'downloaded' });
      if (legacyRowId) await ackDecrypted(owner, [legacyRowId]).catch(() => {});
    } catch {
      if (getMessageStoreOwner() !== owner) return;
      updateVoiceAudio(owner, messageId, { audioState: 'failed' });
    }
    if (getMessageStoreOwner() !== owner) return;
    notifyConversationChanged(conversationId);
  }, []);

  /**
   * Brings this device's copy of one conversation up to date: joins the
   * newest Welcome addressed to it (replacing a stale or forked local
   * group), then decrypts new application messages of its current group.
   * See groupSync.ts for every rule applied to a row, and why.
   *
   * Only ever called through `runConversationSync`, which guarantees one
   * sync per conversation at a time; every non-idempotent step (join,
   * decrypt) is still guarded by an "already processed" check first.
   *
   * Incremental: once a conversation has been synced, only rows from
   * shortly before the newest one already processed are fetched (see
   * SYNC_OVERLAP_MS), and rows already stored are skipped without any
   * write. The cursor only moves when every fetched row has been handled —
   * a sync that stops early (a group this device isn't in yet, a transient
   * native error) reads the same window again next time instead of
   * skipping past rows it hasn't handled.
   *
   * Captures its own owner at entry (`owner`) and re-checks
   * `getMessageStoreOwner() === owner` after every `await` before
   * touching messageStore again — an account switch mid-poll aborts the
   * rest of this call instead of writing this poll's results under
   * whichever account is live by the time a later step runs. The
   * `assertOwnerUnchanged` inside each messageStore write is the same
   * guarantee's backstop, in case a future change here misses a check.
   *
   * Reports whether the device's copy looked unusable (a message of its
   * current group it could not read, or one from a newer group it isn't
   * in) so the caller can rebuild.
   */
  const syncConversation = useCallback(
    async (conversationId: string): Promise<{ unusable: boolean } | null> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return null;
      const cursor = getSyncCursor(owner, conversationId);
      const sinceCreatedAt = cursor ? new Date(Date.parse(cursor) - SYNC_OVERLAP_MS).toISOString() : undefined;
      const groupIdBytes = uuidToBytes(conversationId);
      let localGeneration = getLocalGroupGeneration(owner, conversationId);
      const welcomeProcessedKey = (id: string) => `welcome_processed:${id}`;

      // Only a sync that actually wrote something re-renders the chat.
      let changed = false;
      let complete = true;
      let notMember = false;
      const failedGenerations: number[] = [];
      const own = { deviceId, userId: owner };
      let syncedUpTo = cursor;
      let afterCursor: string | undefined;

      // Page by page (SYNC_PAGE_ROWS each), oldest first: a long history no
      // longer arrives in one response. Each page is fully handled — and the
      // cursor moved past it — before the next is fetched.
      for (;;) {
        let fetched: Awaited<ReturnType<typeof e2eeApi.fetchMessages>>;
        try {
          fetched = await e2eeApi.fetchMessages({
            conversationId,
            ...(sinceCreatedAt ? { sinceCreatedAt } : {}),
            page: { limit: SYNC_PAGE_ROWS, ...(afterCursor ? { after: afterCursor } : {}) },
          });
        } catch {
          if (!afterCursor) return null; // network/server failure this cycle — next poll will retry
          complete = false; // the pages so far stand; the next sync carries on from them
          break;
        }
        if (getMessageStoreOwner() !== owner) return null;

        const rows = orderForSync(fetched);
        const decryptedThisPage: string[] = [];
        const stored = getStoredMessageStates(
          owner,
          rows.map((row) => row.id),
        );
        // Also sees this device's newer Welcomes from beyond the page (the
        // server sends them along), so older rows are never mistaken for a
        // group this device isn't in.
        const welcome = pickWelcome(rows, localGeneration, (row) => getAppState(welcomeProcessedKey(row.id)) === '1');
        const newestGeneration = rows.reduce((max, row) => Math.max(max, row.mlsGeneration), 0);
        if (newestGeneration > (serverGenerationRef.current.get(conversationId) ?? 0)) {
          serverGenerationRef.current.set(conversationId, newestGeneration);
        }

        const recordUnreadable = (row: (typeof rows)[number], status: 'unavailable' | 'decryption_failed') => {
          recordMessage(owner, {
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: isFromOwnAccount(row, own) ? 'outgoing' : 'incoming',
            status,
            plaintext: null,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });
          changed = true;
        };

        // This device's unconfirmed sends (still under local ids), read only
        // once a row this device sent turns up that isn't stored: such a
        // row may be a send whose response was lost. See findPendingSendForRow.
        let pendingSends: { localId: string; ciphertext: string }[] | null = null;

        rowLoop: for (const row of rows) {
          if (getMessageStoreOwner() !== owner) return null;

          // `stored` was read before this loop's first await. A row it doesn't
          // list as processed may have been written since (e.g. our own send
          // confirming under its server id), so that row is re-read
          // synchronously right before acting on it.
          let existing = stored.get(row.id) ?? null;
          if (row.messageType === 'application' && (!existing || existing.status === 'sending')) {
            const fresh = getMessageById(owner, row.id);
            existing = fresh ? { status: fresh.status, createdAt: fresh.createdAt } : null;
          }

          if (row.messageType === 'application' && row.senderDeviceId === deviceId && !existing) {
            pendingSends ??= listPendingOutgoingIds(owner, conversationId).flatMap((localId) => {
              const sealed = readPendingCiphertext(owner, localId);
              return sealed ? [{ localId, ciphertext: sealed.ciphertext }] : [];
            });
            const localId = findPendingSendForRow(row.ciphertext, pendingSends);
            if (localId) {
              // The server has it: confirm the local row in place (its own
              // plaintext stays), exactly as the lost response would have.
              reconcileSentMessageId(owner, localId, row.id, row.createdAt);
              deleteAppState(pendingCiphertextKey(owner, localId));
              pendingSends = pendingSends.filter((send) => send.localId !== localId);
              changed = true;
              continue rowLoop;
            }
          }

          const action = planRow(row, {
            localGeneration,
            targetGeneration: welcome?.mlsGeneration ?? 0,
            welcomeToJoinId: welcome?.id ?? null,
            ownDeviceId: deviceId,
            stored: existing !== null && existing.status !== 'sending',
          });

          switch (action) {
            case 'join': {
              try {
                await joinGroupReplacing(owner, base64ToBytes(row.ciphertext));
                if (getMessageStoreOwner() !== owner) return null;
                setLocalGroupGeneration(owner, conversationId, row.mlsGeneration);
                // A rebuild this device had started is superseded by the group it just joined.
                clearRebuildCandidate(owner, conversationId);
                localGeneration = row.mlsGeneration;
              } catch (err) {
                if (getMessageStoreOwner() !== owner) return null;
                if (!isPermanentWelcomeFailure(err)) {
                  // Storage hiccup: try this Welcome again on the next sync.
                  complete = false;
                  break rowLoop;
                }
                // Not usable by this device (its KeyPackage is gone, e.g. app
                // data was cleared). Never retried; the rows of its group show
                // up as `not_member` below and this device rebuilds.
              }
              setAppState(welcomeProcessedKey(row.id), '1');
              changed = true;
              break;
            }
            case 'skip_welcome':
              if (getAppState(welcomeProcessedKey(row.id)) !== '1') setAppState(welcomeProcessedKey(row.id), '1');
              break;
            case 'already_stored':
              // Already decrypted (or recorded as unreadable), so never
              // decrypted again. The only thing the server can still correct is
              // the ordering timestamp; content, status, kind and audio
              // metadata stay exactly as stored.
              if (existing && existing.createdAt !== row.createdAt) {
                updateMessageCreatedAt(owner, row.id, row.createdAt);
                changed = true;
              }
              break;
            case 'old_generation':
            case 'own_message_lost':
              // Sent before this device joined the current group, or this
              // device's own message whose local copy is gone: MLS never gives
              // this device the keys for either. Not an error.
              recordUnreadable(row, 'unavailable');
              break;
            case 'not_member':
              // From a group this device isn't in. Leave the row (and the
              // cursor) alone; the caller rebuilds the group.
              notMember = true;
              complete = false;
              break rowLoop;
            case 'decrypt': {
              let plaintext: string;
              try {
                // Crash-safe: if the app dies before the result below is
                // stored, the next sync decrypts this row again and gets the
                // same plaintext (MLS alone would refuse it as already used).
                plaintext = await decryptMessageOnce(owner, groupIdBytes, row.id, base64ToBytes(row.ciphertext));
              } catch (err) {
                if (getMessageStoreOwner() !== owner) return null;
                switch (classifyMlsError(err)) {
                  case 'duplicate':
                    // The same send stored twice (a network-level retry); the
                    // first copy was decrypted and is shown. Nothing to add.
                    continue rowLoop;
                  case 'own_message':
                  case 'past_epoch':
                    recordUnreadable(row, 'unavailable');
                    continue rowLoop;
                  case 'transient':
                    complete = false;
                    break rowLoop;
                  case 'no_group':
                    // The local group is gone; rebuilding brings it back.
                    failedGenerations.push(row.mlsGeneration);
                    complete = false;
                    break rowLoop;
                  case 'future_epoch':
                  case 'invalid':
                    // Tampered, or this device's copy of the group is stale or
                    // forked. Never fall back to displaying raw ciphertext or
                    // any guessed content — record an explicit failure the UI
                    // renders as such, and rebuild so later messages are
                    // readable again.
                    recordUnreadable(row, 'decryption_failed');
                    failedGenerations.push(row.mlsGeneration);
                    continue rowLoop;
                }
                continue rowLoop;
              }
              if (getMessageStoreOwner() !== owner) return null;
              const voiceEnvelope = parseVoiceEnvelope(plaintext);
              const outgoing = isFromOwnAccount(row, own);
              recordMessage(owner, {
                id: row.id,
                conversationId,
                senderDeviceId: row.senderDeviceId,
                direction: outgoing ? 'outgoing' : 'incoming',
                status: 'decrypted',
                kind: voiceEnvelope ? 'voice' : 'text',
                plaintext: voiceEnvelope ? null : plaintext,
                audioMediaId: voiceEnvelope?.mediaId ?? null,
                audioDurationMs: voiceEnvelope?.durationMs ?? null,
                audioState: voiceEnvelope ? 'idle' : null,
                audioKey: voiceEnvelope?.key ?? null,
                createdAt: row.createdAt,
                localCreatedAt: row.createdAt,
              });
              changed = true;
              decryptedThisPage.push(row.id);

              const notify = notifyContextRef.current;
              if (!outgoing && Date.parse(row.createdAt) >= notify.sessionStartedAt && notify.shouldPresentLocally()) {
                const conversation = notify.conversations.find((c) => c.id === conversationId);
                presentNewMessageNotification({
                  conversationId,
                  title: conversation?.otherDisplayName ?? 'SecureMessenger',
                  body: voiceEnvelope ? 'Voice message' : 'New message',
                }).catch(() => {});
              }
              if (voiceEnvelope) {
                await fetchVoiceAudio(owner, conversationId, row.id);
                if (getMessageStoreOwner() !== owner) return null;
              }
              break;
            }
          }
        }

        if (getMessageStoreOwner() !== owner) return null;
        // Stored now, so the native side can forget their plaintext. A
        // failure here only leaves them for the sweep at the next start.
        await ackDecrypted(owner, decryptedThisPage).catch(() => {});
        if (getMessageStoreOwner() !== owner) return null;
        if (!complete) break;
        // Out-of-page Welcomes say nothing about how far this sync got.
        const inPage = fetched.filter((row) => !('outOfPage' in row && row.outOfPage));
        const newest = inPage.reduce<string | null>((max, row) => (max === null || row.createdAt > max ? row.createdAt : max), null);
        if (newest && (!syncedUpTo || newest > syncedUpTo)) {
          setSyncCursor(owner, conversationId, newest);
          syncedUpTo = newest;
        }
        // A server from before paging ignores `page` and sends no cursor:
        // its single response is everything.
        const last = inPage[inPage.length - 1];
        if (inPage.length < SYNC_PAGE_ROWS || !last || !('cursor' in last) || !last.cursor) break;
        afterCursor = last.cursor;
      }

      if (getMessageStoreOwner() !== owner) return null;
      if (changed) {
        refreshConversationPreview(owner, conversationId);
        notifyConversationChanged(conversationId);
      }
      return { unusable: sawUnusableGroup({ notMember, failedGenerations, localGeneration }) };
    },
    [deviceId, fetchVoiceAudio],
  );

  /**
   * (Re)builds the conversation's group as generation `expectedGeneration +
   * 1`: one commit adding one fresh KeyPackage of every signed-in device of
   * both members (this install excepted), one Welcome for all of them — see
   * groupSync.ts. Returns true when this device's group is the one the
   * server kept. If another device's rebuild won the race, this device's
   * unpublished group is discarded and it joins the winner's on the next
   * sync.
   */
  const rebuildConversationGroup = useCallback(
    async (owner: string, conversationId: string, expectedGeneration: number): Promise<boolean> => {
      const requireStillOwner = () => {
        if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
      };
      const ownCredential = ownCredentialKeyRef.current;
      const conversation = getConversation(owner, conversationId);
      if (!deviceId || !ownCredential || !conversation) return false;

      const devices: ConversationDevice[] = await e2eeApi.listConversationDevices({ conversationId });
      requireStillOwner();
      const targets = rebuildTargets(devices, { deviceId, credentialPublicKey: ownCredential });
      const members = [owner, conversation.otherUserId];
      const keyed: { device: ConversationDevice; keyPackage: Uint8Array }[] = [];
      const consumeFor = async (group: ConversationDevice[]) => {
        for (const device of group) {
          const { keyPackage } = await e2eeApi.consumeKeyPackage({ targetDeviceId: device.deviceId });
          requireStillOwner();
          if (keyPackage) keyed.push({ device, keyPackage: base64ToBytes(keyPackage) });
        }
      };
      // The other person's devices first: if none of them is reachable the
      // rebuild is abandoned before any of this account's own KeyPackages
      // are used up for nothing.
      await consumeFor(targets.filter((device) => device.userId !== owner));
      if (!coversOtherMembers(keyed.map((k) => k.device.userId), members, owner)) {
        throw new PeerNotReadyError(`${conversation.otherDisplayName}'s device isn't ready to receive encrypted messages yet. Try again shortly.`);
      }
      await consumeFor(targets.filter((device) => device.userId === owner));

      // Everything the server holds for the current group is read and
      // decrypted now, right before that group is deleted by the native
      // rebuild: the device listing and KeyPackage round trips above took
      // time, and a message the other side sent meanwhile would otherwise
      // be lost for this device (grey "not available"). If this sync joined
      // a newer Welcome, the prepared rebuild is for a replaced group and is
      // abandoned (see groupSync.rebuildStillApplies).
      const localGenerationBeforeSync = getLocalGroupGeneration(owner, conversationId);
      await syncConversation(conversationId);
      requireStillOwner();
      if (!rebuildStillApplies({ localGenerationBeforeSync, localGenerationAfterSync: getLocalGroupGeneration(owner, conversationId) })) {
        return false;
      }

      const groupIdBytes = uuidToBytes(conversationId);
      // From here until the server answers, this device's copy of the group
      // is one the server may never accept. The local generation says so (0):
      // a send waits for this to finish instead of encrypting (see
      // encryptAndSend), and a sync treats every row as from a group this
      // device isn't in rather than decrypting with the wrong keys. The
      // candidate is noted first, so a lost answer — or the app killed
      // anywhere in between — can be resolved against the server later
      // (maintainGroup / resolveRebuildCandidate) instead of leaving a
      // mislabelled group behind, which showed every message exchanged in
      // the meantime as "Unable to decrypt".
      setRebuildCandidate(owner, conversationId, expectedGeneration + 1);
      setLocalGroupGeneration(owner, conversationId, 0);
      let rebuilt: Awaited<ReturnType<typeof rebuildGroup>>;
      try {
        rebuilt = await rebuildGroup(owner, groupIdBytes, keyed.map((k) => k.keyPackage));
      } catch (err) {
        requireStillOwner();
        const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
        if (text.includes('InvalidInput')) {
          // Nothing usable to add; the existing copy was left untouched (see
          // rust/src/group.rs rebuild_group), so its label is restored.
          clearRebuildCandidate(owner, conversationId);
          setLocalGroupGeneration(owner, conversationId, expectedGeneration);
        }
        throw err;
      }
      requireStillOwner();
      const recipientDeviceIds = rebuilt.included.flatMap((index) => {
        const entry = keyed[index];
        return entry ? [entry.device.deviceId] : [];
      });

      const request = { conversationId, expectedGeneration, welcome: bytesToBase64(rebuilt.welcome), recipientDeviceIds };
      let response: Awaited<ReturnType<typeof e2eeApi.resetGroup>> | null = null;
      for (let attempt = 0; attempt < 3 && !response; attempt++) {
        try {
          response = await e2eeApi.resetGroup(request);
        } catch (err) {
          // A lost response is retried with the same request: the server
          // reports whether the first attempt already went through. Giving
          // up leaves the candidate noted for a later sync to resolve.
          if (attempt === 2) throw err;
          await sleep(1000 * 2 ** attempt);
        }
      }
      requireStillOwner();
      if (!response) return false;

      if (rebuildWasAccepted(response, expectedGeneration)) {
        setLocalGroupGeneration(owner, conversationId, expectedGeneration + 1);
        clearRebuildCandidate(owner, conversationId);
        serverGenerationRef.current.set(conversationId, expectedGeneration + 1);
        membershipCheckedAtRef.current.set(conversationId, Date.now());
        return true;
      }
      serverGenerationRef.current.set(conversationId, response.generation);
      await deleteGroup(owner, groupIdBytes);
      requireStillOwner();
      clearRebuildCandidate(owner, conversationId);
      return false;
    },
    [deviceId, syncConversation],
  );

  /**
   * After a sync: rebuilds the group if this device can't use it — see
   * groupSync.rebuildReason. Also (every MEMBERSHIP_CHECK_MS) compares the
   * group's members with the members' signed-in devices, so a device whose
   * session was ended stops being able to decrypt new messages.
   * Automatic rebuilds are rate-limited per conversation (mayRebuildNow);
   * `userInitiated` (starting or opening a chat from search) is not, and
   * surfaces a failure to the caller instead of retrying quietly later.
   * Returns whether it rebuilt, so the caller syncs once more and picks up
   * the other side's Welcome if another device won the race.
   */
  const maintainGroup = useCallback(
    async (conversationId: string, syncResult: { unusable: boolean }, userInitiated: boolean): Promise<boolean> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return false;

      // A rebuild this device started without seeing the server's answer
      // (see rebuildConversationGroup): settle it before deciding anything
      // else, on what the server actually kept.
      const candidate = getRebuildCandidate(owner, conversationId);
      if (candidate !== null) {
        const listed = (await e2eeApi.listConversations()).find((row) => row.conversationId === conversationId);
        if (getMessageStoreOwner() !== owner || !listed) return false;
        serverGenerationRef.current.set(conversationId, listed.groupGeneration);
        const resolution = resolveRebuildCandidate({
          candidate,
          localGeneration: getLocalGroupGeneration(owner, conversationId),
          serverGeneration: listed.groupGeneration,
          builtByThisDevice: listed.groupBuiltByThisDevice === true,
        });
        if (resolution === 'adopt') {
          setLocalGroupGeneration(owner, conversationId, candidate);
          clearRebuildCandidate(owner, conversationId);
          membershipCheckedAtRef.current.set(conversationId, Date.now());
          applyConversations(listLocalConversations(owner));
          return true; // the rows of this generation were left unread: sync again
        }
        if (resolution === 'discard') {
          await deleteGroup(owner, uuidToBytes(conversationId));
          if (getMessageStoreOwner() !== owner) return false;
        }
        clearRebuildCandidate(owner, conversationId);
      }

      const localGeneration = getLocalGroupGeneration(owner, conversationId);
      let serverGeneration = serverGenerationRef.current.get(conversationId);
      if (serverGeneration === undefined) {
        const listed = (await e2eeApi.listConversations()).find((row) => row.conversationId === conversationId);
        if (getMessageStoreOwner() !== owner || !listed) return false;
        serverGeneration = listed.groupGeneration;
        serverGenerationRef.current.set(conversationId, serverGeneration);
      }

      let signedOutMembers = 0;
      const checkedAt = membershipCheckedAtRef.current.get(conversationId) ?? 0;
      if (localGeneration > 0 && localGeneration === serverGeneration && Date.now() - checkedAt >= MEMBERSHIP_CHECK_MS) {
        membershipCheckedAtRef.current.set(conversationId, Date.now());
        const [devices, memberKeys] = await Promise.all([
          e2eeApi.listConversationDevices({ conversationId }),
          groupMemberSignatureKeys(owner, uuidToBytes(conversationId)),
        ]);
        if (getMessageStoreOwner() !== owner) return false;
        signedOutMembers = signedOutMemberKeys(
          memberKeys.map(bytesToBase64),
          devices.map((device) => device.credentialPublicKey),
        ).length;
      }

      if (!rebuildReason({ serverGeneration, localGeneration, unreadable: syncResult.unusable, signedOutMembers })) return false;
      if (!mayRebuildNow(lastRebuildAtRef.current.get(conversationId), Date.now(), userInitiated)) return false;
      lastRebuildAtRef.current.set(conversationId, Date.now());
      let accepted = false;
      try {
        // Rebuilding replaces this device's copy of the group before the
        // server confirms it, so decide on the server's current generation,
        // not a cached one that another device may have moved past.
        const listed = (await e2eeApi.listConversations()).find((row) => row.conversationId === conversationId);
        if (getMessageStoreOwner() !== owner || !listed) return false;
        serverGenerationRef.current.set(conversationId, listed.groupGeneration);
        if (listed.groupGeneration !== serverGeneration) return true; // moved on: sync first, then decide again
        accepted = await rebuildConversationGroup(owner, conversationId, serverGeneration);
      } catch (err) {
        if (userInitiated) throw err;
        // Retried after the cooldown, on a later sync.
      }
      if (getMessageStoreOwner() !== owner) return false;
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
      applyConversations(listLocalConversations(owner));
      return !accepted;
    },
    [deviceId, rebuildConversationGroup, applyConversations],
  );

  /**
   * One sync per conversation at a time. The chat screen's interval, the
   * conversation-list refresh and a returning-to-foreground refresh can all
   * ask for the same conversation while a sync is still in flight (slow
   * network, a long first sync); instead of overlapping requests and
   * decrypt attempts, the later request is folded into a single follow-up
   * sync once the running one finishes, and every caller's promise
   * resolves after data at least as new as its request. Group maintenance
   * (joining, rebuilding) runs inside the same slot, so a rebuild never
   * overlaps a sync or another rebuild of the same conversation.
   */
  const syncStateRef = useRef(new Map<string, { running: Promise<void>; again: boolean; userInitiated: boolean }>());

  const runConversationSync = useCallback(
    (conversationId: string, userInitiated: boolean): Promise<void> => {
      const states = syncStateRef.current;
      const inFlight = states.get(conversationId);
      if (inFlight) {
        inFlight.again = true;
        inFlight.userInitiated ||= userInitiated;
        return inFlight.running;
      }
      const state = { running: Promise.resolve(), again: false, userInitiated };
      state.running = (async () => {
        try {
          do {
            state.again = false;
            const initiated = state.userInitiated;
            state.userInitiated = false;
            const result = await syncConversation(conversationId);
            if (!result) continue;
            // A lost rebuild race means another device's Welcome is waiting.
            if (await maintainGroup(conversationId, result, initiated)) state.again = true;
          } while (state.again);
        } finally {
          states.delete(conversationId);
        }
      })();
      states.set(conversationId, state);
      return state.running;
    },
    [syncConversation, maintainGroup],
  );

  const pollConversation = useCallback(
    (conversationId: string): Promise<void> => runConversationSync(conversationId, false).catch(() => {}),
    [runConversationSync],
  );

  const refreshConversations = useCallback(async (): Promise<void> => {
    const owner = getMessageStoreOwner();
    if (!owner) return;

    let remote: Awaited<ReturnType<typeof e2eeApi.listConversations>>;
    try {
      remote = await e2eeApi.listConversations();
    } catch {
      if (getMessageStoreOwner() !== owner) return; // logout raced this call — nothing to reconcile against
      applyConversations(listLocalConversations(owner));
      return;
    }
    if (getMessageStoreOwner() !== owner) return;

    // Only conversations that are new here, or whose other party's profile
    // changed, need a write — this runs every CONVERSATIONS_POLL_MS. (A row
    // this account doesn't own yet isn't in `local`, so it is still upserted
    // and owner-stamped exactly as before.)
    const local = new Map(listLocalConversations(owner).map((conversation) => [conversation.id, conversation]));
    for (const row of remote) {
      serverGenerationRef.current.set(row.conversationId, row.groupGeneration);
      const existing = local.get(row.conversationId);
      if (existing && existing.otherUsername === row.otherUser.username && existing.otherDisplayName === row.otherUser.displayName) {
        continue;
      }
      upsertConversation(owner, {
        id: row.conversationId,
        otherUserId: row.otherUser.id,
        otherUsername: row.otherUser.username,
        otherDisplayName: row.otherUser.displayName,
        createdAt: row.createdAt,
      });
    }

    // The list is on screen before any group work: the syncs below can take
    // a while (a rebuild is several round trips, longer on a slow network),
    // and until they finished a freshly signed-in device showed an empty
    // chat list — "Tap the compose icon to start an encrypted chat" — for
    // conversations it already had.
    applyConversations(listLocalConversations(owner));

    // Syncs every conversation this device isn't on the current group of —
    // one someone just started with us, one whose group was rebuilt (a new
    // Welcome is waiting), one this device must rebuild — plus any due a
    // membership check, even before the user opens it.
    const now = Date.now();
    for (const row of remote) {
      if (getMessageStoreOwner() !== owner) return;
      const behind = row.groupGeneration === 0 || getLocalGroupGeneration(owner, row.conversationId) !== row.groupGeneration;
      const membershipDue = now - (membershipCheckedAtRef.current.get(row.conversationId) ?? 0) >= MEMBERSHIP_CHECK_MS;
      if (behind || membershipDue) {
        await pollConversation(row.conversationId);
        if (getMessageStoreOwner() !== owner) return;
      }
    }

    if (getMessageStoreOwner() !== owner) return;
    applyConversations(listLocalConversations(owner));
  }, [pollConversation, applyConversations]);

  useEffect(() => {
    if (status !== 'authenticated') {
      // Covers both explicit logout and an automatic invalid-session
      // logout. The local SQLite cache for the account that just signed
      // out is NOT touched (see messageStore's owner-scoping) — this
      // only clears this provider's in-memory mirror, so nothing lingers
      // on screen for the instant before either a new login's own
      // refreshConversations() resolves, or that same account signing
      // back in makes its untouched data visible again.
      setConversations([]);
      setE2eeReady(false);
      setE2eeError(null);
      return;
    }
    // What this device already has, right away — before (and without)
    // reaching the server, so an app started offline still shows its chats.
    const owner = getMessageStoreOwner();
    if (owner) applyConversations(listLocalConversations(owner));
    ensureE2eeSetup();
  }, [status, ensureE2eeSetup, applyConversations]);

  // Setup needs the server; one that failed (e.g. the app was started
  // offline) is retried when the connection or the app comes back instead
  // of waiting for the user to find the retry button.
  useEffect(() => {
    if (status !== 'authenticated' || e2eeReady || !e2eeError) return;
    const offStatus = realtime.onStatus((next) => {
      if (next === 'online') void ensureE2eeSetup();
    });
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void ensureE2eeSetup();
    });
    const timer = setInterval(() => void ensureE2eeSetup(), 30 * 1000);
    return () => {
      offStatus();
      subscription.remove();
      clearInterval(timer);
    };
  }, [status, e2eeReady, e2eeError, ensureE2eeSetup]);

  useEffect(() => {
    if (status !== 'authenticated' || !e2eeReady) return;
    refreshConversations();

    // Polls only while the app is in the foreground (an audit fix: polling
    // while backgrounded was a real, cumulative battery/network cost), with
    // an immediate refresh on returning so the list isn't stale on resume.
    //
    // The wait between polls comes from pollSchedule.ts: a slow, jittered
    // safety net while the realtime socket delivers hints; while the socket
    // is down it starts fast and backs off with every quiet poll (6 → 12 →
    // 24 → 30 s), resetting when the app comes to the foreground. A fixed
    // cadence turned a realtime outage into a database outage at scale
    // (docs/ENGINEERING_CHECKLIST.md, S1).
    let stopped = false;
    let quietPolls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer || stopped) return;
      const delay = nextPollDelayMs({
        realtimeOnline: realtime.getStatus() === 'online',
        quietPolls,
        baseMs: CONVERSATIONS_POLL_MS,
        onlineMs: ONLINE_POLL_MS,
      });
      timer = setTimeout(async () => {
        timer = null;
        const online = realtime.getStatus() === 'online';
        await refreshConversations();
        if (stopped) return;
        quietPolls = online ? 0 : quietPolls + 1;
        if (AppState.currentState === 'active') schedule();
      }, delay);
    };
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (AppState.currentState === 'active') schedule();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        quietPolls = 0;
        refreshConversations();
        // Other people starting chats with this device while it was away
        // use up its KeyPackages too.
        topUpKeyPackages().catch(() => {});
        schedule();
      } else {
        stop();
      }
    });

    return () => {
      stopped = true;
      stop();
      subscription.remove();
    };
    // refreshConversations is stable enough (recreated only when
    // pollConversation's deviceId dependency changes) for this interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, e2eeReady]);

  // "Conversation updated" hints from the realtime socket: sync that
  // conversation right away instead of on the next poll, and catch up on
  // everything whenever the socket (re)connects.
  useEffect(() => {
    if (status !== 'authenticated' || !e2eeReady) return;
    const offEvent = realtime.onEvent((event) => {
      if (event.type !== 'conversation.updated') return;
      const owner = getMessageStoreOwner();
      if (owner && getConversation(owner, event.conversationId)) {
        void pollConversation(event.conversationId).then(() => {
          if (getMessageStoreOwner() === owner) applyConversations(listLocalConversations(owner));
        });
      } else {
        void refreshConversations();
      }
    });
    const offStatus = realtime.onStatus((next) => {
      if (next === 'online') void refreshConversations();
    });
    return () => {
      offEvent();
      offStatus();
    };
  }, [status, e2eeReady, pollConversation, refreshConversations, applyConversations]);

  /**
   * Deduplicates concurrent `startConversation` calls for the same
   * `otherUserId` to a single shared in-flight promise (cleared on
   * settle). The server's `createConversation` is itself the real
   * uniqueness guarantee now (advisory-lock-serialized find-or-create —
   * see the server-side change), so this exists only to avoid redundant
   * round-trips/local churn from a client-side retry racing its own
   * still-in-flight first attempt (e.g. navigating back to "New chat"
   * and re-selecting the same person before the first request settles)
   * — not a stale per-screen-instance flag like `NewConversationScreen`'s
   * own `disabled={startingId !== null}`, which resets on remount.
   */
  const startConversationInFlightRef = useRef<Map<string, Promise<string>>>(new Map());

  /**
   * Makes sure this device can use the conversation: syncs it (joining a
   * Welcome waiting for it), then — if the conversation has no group yet,
   * or this device isn't in its current one — builds it. Two people (or
   * two devices) doing this at once is safe: the server keeps exactly one
   * build and everyone else joins it (see groupSync.ts). Replaces the old
   * create-then-add-each-device flow, which could leave the two sides in
   * different groups.
   */
  const startConversationImpl = useCallback(
    async (otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string> => {
      const owner = getMessageStoreOwner();
      if (!owner) throw new Error('You are not signed in.');

      const { conversationId, groupGeneration } = await e2eeApi.createConversation({ otherUserId });
      if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
      upsertConversation(owner, {
        id: conversationId,
        otherUserId,
        otherUsername,
        otherDisplayName,
        createdAt: nowIso(),
      });
      serverGenerationRef.current.set(conversationId, groupGeneration);

      if (groupGeneration === 0 || getLocalGroupGeneration(owner, conversationId) !== groupGeneration) {
        try {
          await runConversationSync(conversationId, true);
        } catch (err) {
          if (err instanceof PeerNotReadyError) throw err;
          throw new Error(getApiErrorMessage(err, `Couldn't set up encryption with ${otherDisplayName}. Try again shortly.`));
        }
      }
      if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
      if (getLocalGroupGeneration(owner, conversationId) === 0) {
        throw new Error(`${otherDisplayName}'s device isn't ready to receive encrypted messages yet. Try again shortly.`);
      }

      applyConversations(listLocalConversations(owner));
      return conversationId;
    },
    [runConversationSync, applyConversations],
  );

  const startConversation = useCallback(
    async (otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string> => {
      const inFlight = startConversationInFlightRef.current.get(otherUserId);
      if (inFlight) return inFlight;

      const run = async (): Promise<string> => {
        try {
          return await startConversationImpl(otherUserId, otherUsername, otherDisplayName);
        } finally {
          startConversationInFlightRef.current.delete(otherUserId);
        }
      };

      const promise = run();
      startConversationInFlightRef.current.set(otherUserId, promise);
      return promise;
    },
    [startConversationImpl],
  );

  /**
   * Encrypts with the conversation's current group and sends, tagged with
   * that group's generation. If the conversation moved to a newer group in
   * the meantime (another device rebuilt it) the server refuses the send
   * rather than storing a message nobody else can read; this device then
   * syncs (joining the new group) and sends once more, re-encrypted. The
   * same happens when the group changes under the send locally (a rebuild
   * or join between reading the generation and encrypting — see
   * encryptForGeneration). While the local generation is 0 — no group yet,
   * or a rebuild in progress — the send waits for the conversation's sync
   * slot (which is where rebuilds run) instead of encrypting for a group
   * the server may not keep.
   *
   * A send that fails for a passing reason (no answer, a timeout, a server
   * error, a rate limit) is made again a bounded number of times before it
   * is reported as failed. Safe to repeat: the same ciphertext is sent each
   * time (sealOnce), so one that did reach the server is answered with the
   * original message, never stored twice. Resolves to null when the send
   * was confirmed meanwhile by a sync that found its bytes on the server
   * (see syncConversation / findPendingSendForRow) — the local row is then
   * already settled, and nothing more may be encrypted for it, or the
   * message would be stored a second time.
   */
  const encryptAndSend = useCallback(
    async (
      owner: string,
      conversationId: string,
      localId: string,
      send: (generation: number) => Promise<{ messageId: string; createdAt?: string }>,
    ): Promise<{ messageId: string; createdAt?: string } | null> => {
      const attempt = async () => {
        const row = getMessageById(owner, localId);
        if (!row || row.status !== 'sending') return null;
        let generation = getLocalGroupGeneration(owner, conversationId);
        if (generation === 0) {
          await runConversationSync(conversationId, true);
          if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
          if (getMessageById(owner, localId)?.status !== 'sending') return null;
          generation = getLocalGroupGeneration(owner, conversationId);
        }
        if (generation === 0) throw new Error('This conversation is not ready to send messages yet.');
        return send(generation);
      };
      let groupRetries = 0;
      let transientRetries = 0;
      for (;;) {
        try {
          return await attempt();
        } catch (err) {
          if (getMessageStoreOwner() !== owner) throw err;
          if ((isStaleGenerationError(err) || err instanceof GroupChangedError) && groupRetries < 2) {
            groupRetries += 1;
            if (isStaleGenerationError(err)) await pollConversation(conversationId);
            if (getMessageStoreOwner() !== owner) throw err;
            continue;
          }
          if (isRetryableApiFailure(err) && transientRetries < SEND_RETRIES) {
            await sleep(backoffDelayMs(transientRetries, SEND_RETRY_BASE_MS, SEND_RETRY_CAP_MS));
            transientRetries += 1;
            if (getMessageStoreOwner() !== owner) throw err;
            continue;
          }
          throw err;
        }
      }
    },
    [pollConversation, runConversationSync],
  );

  /**
   * Sends in one conversation go out one at a time, in the order the user
   * made them. They used to run concurrently, so when one request was slow
   * (a lost response the network layer resends, see the server's duplicate
   * handling in e2ee.sendMessage) a later message reached the server — and
   * so the chat — before an earlier one.
   */
  const sendQueueRef = useRef(new Map<string, Promise<void>>());
  const inSendOrder = useCallback((conversationId: string, send: () => Promise<void>): Promise<void> => {
    const queue = sendQueueRef.current;
    const previous = queue.get(conversationId) ?? Promise.resolve();
    const next = previous.then(send, send);
    queue.set(conversationId, next);
    void next.finally(() => {
      if (queue.get(conversationId) === next) queue.delete(conversationId);
    });
    return next;
  }, []);

  const attemptSendNow = useCallback(
    async (conversationId: string, localId: string, text: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      try {
        const sent = await encryptAndSend(owner, conversationId, localId, async (generation) => {
          const ciphertext = await sealOnce(owner, localId, generation, () => encryptForGeneration(owner, conversationId, generation, text));
          return e2eeApi.sendMessage({
            conversationId,
            ciphertext,
            messageType: 'application',
            mlsGeneration: generation,
          });
        });
        if (getMessageStoreOwner() !== owner) return; // sent server-side either way; local reconcile only applies under the account that sent it
        if (sent) {
          // The server's own timestamp when it returns one (older servers
          // don't), so ordering is right before the next sync confirms it.
          reconcileSentMessageId(owner, localId, sent.messageId, sent.createdAt ?? nowIso());
          deleteAppState(pendingCiphertextKey(owner, localId));
        }
      } catch {
        if (getMessageStoreOwner() !== owner) return;
        updateMessageStatus(owner, localId, 'failed');
      }
      if (getMessageStoreOwner() !== owner) return;
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
    },
    [deviceId, encryptAndSend],
  );

  const attemptSend = useCallback(
    (conversationId: string, localId: string, text: string): Promise<void> =>
      inSendOrder(conversationId, () => attemptSendNow(conversationId, localId, text)),
    [inSendOrder, attemptSendNow],
  );

  /**
   * Mirrors `attemptSend` exactly (same owner-capture-and-recheck-after-
   * every-await pattern), but for a voice message's two-part send: the
   * audio is sealed under a fresh random content key (see
   * rust/src/blob.rs) and uploaded as opaque bytes to the REST media
   * endpoint; a small JSON envelope (mediaId, duration, the key) is then
   * sent through the existing `sendMessage` path, exactly like a text
   * message — the MLS-protected envelope is what carries the key. The
   * local optimistic row already has `audioLocalUri` pointing at the
   * just-recorded file (see `sendVoiceMessage`), so the sender's own
   * bubble is playable immediately — this function's only job is to get
   * the blob+metadata to the server and reconcile the local id.
   *
   * The key and the uploaded blob's id are stored on the local row as soon
   * as each exists, so a retry after a failure between upload and send
   * reuses the upload instead of leaving it orphaned. Neither depends on
   * the group's generation: a group change only re-seals the envelope.
   */
  const attemptSendVoiceNow = useCallback(
    async (conversationId: string, localId: string, localFileUri: string, durationMs: number): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      try {
        const bytes = await readAudioBytes(localFileUri);
        if (getMessageStoreOwner() !== owner) return;

        const sent = await encryptAndSend(owner, conversationId, localId, async (generation) => {
          const row = getMessageById(owner, localId);
          let mediaId = row?.audioMediaId ?? null;
          let key = row?.audioKey ?? null;
          if (!key) {
            // No key: either a fresh send, or a blob uploaded by an app
            // version before content keys (an MLS application message a
            // retry can no longer reference). Either way, seal and upload anew.
            mediaId = null;
            key = bytesToBase64(await generateBlobKey());
            if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
            setVoiceBlob(owner, localId, { mediaId: null, key });
          }
          if (!mediaId) {
            const sealed = await sealBlob(base64ToBytes(key), bytes);
            if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
            const uploaded = await uploadVoiceBlob(conversationId, sealed);
            if (getMessageStoreOwner() !== owner) throw new Error('Signed out before this could finish.');
            mediaId = uploaded.mediaId;
            setVoiceBlob(owner, localId, { mediaId });
          }

          const envelope = buildVoiceEnvelope({ mediaId, durationMs, byteSize: bytes.length, mimeType: 'audio/m4a', key });
          const metadataCiphertext = await sealOnce(owner, localId, generation, () =>
            encryptForGeneration(owner, conversationId, generation, envelope),
          );
          return e2eeApi.sendMessage({
            conversationId,
            ciphertext: metadataCiphertext,
            messageType: 'application',
            mlsGeneration: generation,
          });
        });
        if (getMessageStoreOwner() !== owner) return; // sent server-side either way; local reconcile only applies under the account that sent it
        if (sent) {
          reconcileSentMessageId(owner, localId, sent.messageId, sent.createdAt ?? nowIso());
          deleteAppState(pendingCiphertextKey(owner, localId));
        }
      } catch {
        if (getMessageStoreOwner() !== owner) return;
        updateMessageStatus(owner, localId, 'failed');
      }
      if (getMessageStoreOwner() !== owner) return;
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
    },
    [deviceId, encryptAndSend],
  );

  const attemptSendVoice = useCallback(
    (conversationId: string, localId: string, localFileUri: string, durationMs: number): Promise<void> =>
      inSendOrder(conversationId, () => attemptSendVoiceNow(conversationId, localId, localFileUri, durationMs)),
    [inSendOrder, attemptSendVoiceNow],
  );

  /** Resolves once this device is on the conversation's group, trying to (re)build it if needed; throws if it can't be used yet. */
  const requireUsableGroup = useCallback(
    async (owner: string, conversationId: string): Promise<void> => {
      if (getLocalGroupGeneration(owner, conversationId) > 0) return;
      await runConversationSync(conversationId, true);
      if (getMessageStoreOwner() !== owner || getLocalGroupGeneration(owner, conversationId) === 0) {
        throw new Error('This conversation is not ready to send messages yet.');
      }
    },
    [runConversationSync],
  );

  const sendChatMessage = useCallback(
    async (conversationId: string, text: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      await requireUsableGroup(owner, conversationId);
      const localId = randomLocalId();
      const timestamp = nowIso();
      recordMessage(owner, {
        id: localId,
        conversationId,
        senderDeviceId: deviceId,
        direction: 'outgoing',
        status: 'sending',
        plaintext: text,
        createdAt: timestamp,
        localCreatedAt: timestamp,
      });
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
      await attemptSend(conversationId, localId, text);
    },
    [deviceId, attemptSend, requireUsableGroup],
  );

  /**
   * `recordedUri` is wherever expo-audio wrote the just-stopped
   * recording (its own cache directory, which the OS may purge) — this
   * function's first job is moving it into this app's persistent,
   * owner-scoped storage (`voiceFiles.persistRecording`) before anything
   * else touches it, so the composer's caller never has to know about
   * storage layout. The optimistic row records the persisted uri
   * immediately as `audioState: 'downloaded'` (not 'idle') because,
   * unlike a received voice message, the sender already has the real
   * audio on disk — there is nothing to download.
   */
  const sendVoiceMessage = useCallback(
    async (conversationId: string, recordedUri: string, durationMs: number): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      await requireUsableGroup(owner, conversationId);
      const localId = randomLocalId();
      const persistedUri = await persistRecording(owner, conversationId, localId, recordedUri);
      if (getMessageStoreOwner() !== owner) return;

      const timestamp = nowIso();
      recordMessage(owner, {
        id: localId,
        conversationId,
        senderDeviceId: deviceId,
        direction: 'outgoing',
        status: 'sending',
        kind: 'voice',
        plaintext: null,
        audioDurationMs: durationMs,
        audioLocalUri: persistedUri,
        audioState: 'downloaded',
        createdAt: timestamp,
        localCreatedAt: timestamp,
      });
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
      await attemptSendVoice(conversationId, localId, persistedUri, durationMs);
    },
    [deviceId, attemptSendVoice, requireUsableGroup],
  );

  /** Fetches a received voice message's audio if the sync couldn't (see fetchVoiceAudio). */
  const downloadVoiceMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!owner) return;
      await fetchVoiceAudio(owner, conversationId, messageId);
    },
    [fetchVoiceAudio],
  );

  const retryMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!owner) return;
      const row = getMessageById(owner, messageId);
      if (!row) return;
      if (row.kind === 'voice') {
        // The original recording is only ever deleted when the message
        // that references it is (never today — see messageStore's
        // no-delete-on-logout policy), so its absence here means the
        // underlying file is genuinely gone (e.g. app storage was
        // cleared) — nothing left to retry with.
        if (!row.audioLocalUri) return;
        updateMessageStatus(owner, messageId, 'sending');
        notifyConversationChanged(conversationId);
        await attemptSendVoice(conversationId, messageId, row.audioLocalUri, row.audioDurationMs ?? 0);
        return;
      }
      if (row.plaintext === null) return;
      updateMessageStatus(owner, messageId, 'sending');
      notifyConversationChanged(conversationId);
      await attemptSend(conversationId, messageId, row.plaintext);
    },
    [attemptSend, attemptSendVoice],
  );

  // Sends again what the app was killed in the middle of sending. Safe to
  // repeat: a retry sends the very same ciphertext (sealOnce), so one that
  // did reach the server is answered there with the original message.
  useEffect(() => {
    if (!e2eeReady) return;
    const pending = interruptedSendsRef.current.splice(0);
    if (pending.length === 0) return;
    void (async () => {
      for (const { id, conversationId } of pending) {
        await retryMessage(conversationId, id).catch(() => {});
      }
    })();
  }, [e2eeReady, retryMessage]);

  const searchUsers = useCallback(async (query: string): Promise<UserSearchResult[]> => {
    if (!query.trim()) return [];
    return usersApi.search({ query });
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      conversations,
      e2eeReady,
      e2eeError,
      retryE2eeSetup: ensureE2eeSetup,
      refreshConversations,
      startConversation,
      pollConversation,
      sendChatMessage,
      sendVoiceMessage,
      downloadVoiceMessage,
      retryMessage,
      searchUsers,
    }),
    [
      conversations,
      e2eeReady,
      e2eeError,
      ensureE2eeSetup,
      refreshConversations,
      startConversation,
      pollConversation,
      sendChatMessage,
      sendVoiceMessage,
      downloadVoiceMessage,
      retryMessage,
      searchUsers,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
