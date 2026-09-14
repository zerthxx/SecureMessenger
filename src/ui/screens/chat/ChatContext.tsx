import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import type { Conversation } from '@/domain/entities';
import { base64ToBytes, bytesToBase64 } from '@/infrastructure/crypto/base64';
import {
  addMemberToGroup,
  createGroup,
  decryptMessage,
  encryptMessage,
  ensureMlsCoreInitialized,
  generateDeviceCredential,
  generateIdentityKey,
  generateKeyPackages,
  joinGroupFromWelcome,
} from '@/infrastructure/crypto/mlsCore';
import { uuidToBytes } from '@/infrastructure/crypto/uuid';
import { e2eeApi, getApiErrorMessage, usersApi } from '@/infrastructure/network/trpcClient';
import { downloadVoiceBlob, uploadVoiceBlob } from '@/infrastructure/network/voiceMediaApi';
import {
  getAppState,
  getMessageById,
  getMessageStoreOwner,
  getStoredMessageStates,
  getSyncCursor,
  initMessageStore,
  isConversationJoined,
  listLocalConversations,
  markConversationJoined,
  recordMessage,
  reconcileSentMessageId,
  refreshConversationPreview,
  setAppState,
  setMessageStoreOwner,
  setSyncCursor,
  setVoiceMediaId,
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
const CONVERSATIONS_POLL_MS = 6000;
/** With the realtime socket connected, only every Nth list poll runs (30 s): changes arrive as hints instead. */
const ONLINE_POLL_EVERY = 5;

/**
 * How far before the newest already-processed message an incremental sync
 * starts reading again. A row is timestamped when its insert starts, so a
 * row that commits a moment after a later-stamped one could otherwise land
 * behind the cursor; anything re-read inside this window is skipped by id.
 */
const SYNC_OVERLAP_MS = 2 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function randomLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

/**
 * Voice-message metadata travels through the exact same protected
 * message path as text (`encryptMessage`/`sendMessage`/`fetchMessages`/
 * `decryptMessage` — see mlsCore.ts) as a small JSON envelope, prefixed
 * so it can never be confused with genuine user-typed text (no real chat
 * message starts with a NUL-adjacent control-free ASCII tag like this by
 * accident, and this app controls both the sender and receiver side of
 * the encoding, so the exact prefix only needs to not collide with itself).
 * The actual audio bytes never travel this path — see `attemptSendVoice`.
 */
const VOICE_ENVELOPE_PREFIX = 'SMVOICE1:';

interface VoiceEnvelope {
  mediaId: string;
  durationMs: number;
  byteSize: number;
  mimeType: string;
}

function buildVoiceEnvelope(envelope: VoiceEnvelope): string {
  return VOICE_ENVELOPE_PREFIX + JSON.stringify(envelope);
}

function parseVoiceEnvelope(plaintext: string): VoiceEnvelope | null {
  if (!plaintext.startsWith(VOICE_ENVELOPE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(plaintext.slice(VOICE_ENVELOPE_PREFIX.length));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as VoiceEnvelope).mediaId === 'string' &&
      typeof (parsed as VoiceEnvelope).durationMs === 'number' &&
      typeof (parsed as VoiceEnvelope).byteSize === 'number' &&
      typeof (parsed as VoiceEnvelope).mimeType === 'string'
    ) {
      return parsed as VoiceEnvelope;
    }
  } catch {
    // Not a (parseable) voice envelope — never thrown further; the
    // caller falls back to treating this as an ordinary text message.
  }
  return null;
}

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
  }, [user?.id]);

  /**
   * Runs once per authenticated session: identity key, device
   * credential, and an initial KeyPackage batch, all idempotent (see
   * each function's own doc comments — generateIdentityKey/
   * generateDeviceCredential no-op if already set locally,
   * registerIdentityKey/registerDeviceCredential no-op if already set
   * server-side, and the KeyPackage batch is gated on a local flag so
   * app restarts don't keep growing the published pool).
   *
   * The KeyPackage-published flag is keyed by the server device id, not
   * a flat key — the local SQLite cache is one file per app *install*,
   * not per account, so two different accounts signing in on the same
   * device (switching accounts, a QA device, etc.) would otherwise share
   * one global flag: the second account to run this would see the
   * first's "already published" flag and skip publishing its own
   * KeyPackages entirely, leaving it permanently unaddable to any group.
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

  const ensureE2eeSetup = useCallback((): Promise<void> => {
    if (!deviceId || !user) return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;

    const run = async () => {
      try {
        await ensureMlsCoreInitialized(user.id);

        const identity = await generateIdentityKey();
        await e2eeApi.registerIdentityKey({ publicKey: bytesToBase64(identity.publicKey) });

        const credential = await generateDeviceCredential();
        await e2eeApi.registerDeviceCredential({
          credentialPublicKey: bytesToBase64(credential.credentialPublicKey),
          crossSignature: bytesToBase64(credential.crossSignature),
        });

        const publishedFlagKey = `keyPackagesPublished:${deviceId}`;
        if (getAppState(publishedFlagKey) !== 'true') {
          const keyPackages = await generateKeyPackages(KEY_PACKAGE_BATCH_SIZE);
          await e2eeApi.publishKeyPackages({ keyPackages: keyPackages.map(bytesToBase64) });
          setAppState(publishedFlagKey, 'true');
        }

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
  }, [deviceId, user]);

  /**
   * Looks for a Welcome message addressed to this device and, for
   * already-joined groups, decrypts any new application messages. Only
   * ever called through `pollConversation`, which guarantees a single
   * sync per conversation at a time; every non-idempotent step (join,
   * decrypt) is still guarded by an "already processed" check against the
   * local store first.
   *
   * Incremental: once a conversation has been synced, only rows from
   * shortly before the newest one already processed are fetched (see
   * SYNC_OVERLAP_MS), and rows already stored are skipped without any
   * write. Measured on v0.7.0, re-downloading and re-writing the whole
   * history on every 3-second poll cost ~2.4 MB and ~4.5 s of JS-thread
   * time per minute with a 300-message chat open.
   *
   * Captures its own owner at entry (`owner`) and re-checks
   * `getMessageStoreOwner() === owner` after every `await` before
   * touching messageStore again — an account switch mid-poll aborts the
   * rest of this call instead of writing this poll's results under
   * whichever account is live by the time a later step runs. The
   * `assertOwnerUnchanged` inside each messageStore write is the same
   * guarantee's backstop, in case a future change here misses a check.
   */
  const syncConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      const cursor = getSyncCursor(owner, conversationId);
      const sinceCreatedAt = cursor ? new Date(Date.parse(cursor) - SYNC_OVERLAP_MS).toISOString() : undefined;
      let rows: Awaited<ReturnType<typeof e2eeApi.fetchMessages>>;
      try {
        rows = await e2eeApi.fetchMessages(sinceCreatedAt ? { conversationId, sinceCreatedAt } : { conversationId });
      } catch {
        return; // network/server failure this cycle — next poll will retry
      }
      if (getMessageStoreOwner() !== owner) return;

      const groupIdBytes = uuidToBytes(conversationId);
      const stored = getStoredMessageStates(
        owner,
        rows.map((row) => row.id),
      );
      // Only a sync that actually wrote something re-renders the chat.
      let changed = false;
      let newestProcessedAt: string | null = null;

      for (const row of rows) {
        if (getMessageStoreOwner() !== owner) return;

        if (row.messageType === 'welcome') {
          if (getAppState(`welcome_processed:${row.id}`) !== '1') {
            try {
              await joinGroupFromWelcome(base64ToBytes(row.ciphertext));
              if (getMessageStoreOwner() !== owner) return;
              markConversationJoined(owner, conversationId);
            } catch {
              // Already joined (e.g. this device processed it in an
              // earlier session before the flag was recorded) or a
              // malformed Welcome — either way, nothing more to do with
              // this specific message.
            }
            if (getMessageStoreOwner() !== owner) return;
            setAppState(`welcome_processed:${row.id}`, '1');
            changed = true;
          }
          newestProcessedAt = row.createdAt;
          continue;
        }

        // application message
        //
        // `stored` was read before this loop's first await. A row it doesn't
        // list as processed may have been written since (e.g. our own send
        // confirming under its server id), so that row is re-read
        // synchronously right before acting on it — the same guard the
        // per-row lookup always gave.
        let existing = stored.get(row.id) ?? null;
        if (!existing || existing.status === 'sending') {
          const fresh = getMessageById(owner, row.id);
          existing = fresh ? { status: fresh.status, createdAt: fresh.createdAt } : null;
        }
        if (existing && existing.status !== 'sending') {
          // Already decrypted (or recorded as undecryptable), so never
          // decrypted again. The only thing the server can still correct is
          // the ordering timestamp; content, status, kind and audio metadata
          // stay exactly as stored.
          if (existing.createdAt !== row.createdAt) {
            updateMessageCreatedAt(owner, row.id, row.createdAt);
            changed = true;
          }
          newestProcessedAt = row.createdAt;
          continue;
        }

        if (row.senderDeviceId === deviceId) {
          // Our own message, not found locally (e.g. local cache lost).
          // MLS erases a sent generation's key material right after
          // use — this device cannot recover its own past plaintext.
          recordMessage(owner, {
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: 'outgoing',
            status: 'decryption_failed',
            plaintext: null,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });
          changed = true;
          newestProcessedAt = row.createdAt;
          continue;
        }

        try {
          const plaintext = await decryptMessage(groupIdBytes, base64ToBytes(row.ciphertext));
          if (getMessageStoreOwner() !== owner) return;
          const voiceEnvelope = parseVoiceEnvelope(plaintext);
          recordMessage(owner, {
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: 'incoming',
            status: 'decrypted',
            kind: voiceEnvelope ? 'voice' : 'text',
            plaintext: voiceEnvelope ? null : plaintext,
            audioMediaId: voiceEnvelope?.mediaId ?? null,
            audioDurationMs: voiceEnvelope?.durationMs ?? null,
            // Never downloaded yet — the receiving side fetches+decrypts
            // the audio blob lazily, on first playback (downloadVoiceMessage).
            audioState: voiceEnvelope ? 'idle' : null,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });

          const notify = notifyContextRef.current;
          if (Date.parse(row.createdAt) >= notify.sessionStartedAt && notify.shouldPresentLocally()) {
            const conversation = notify.conversations.find((c) => c.id === conversationId);
            presentNewMessageNotification({
              conversationId,
              title: conversation?.otherDisplayName ?? 'SecureMessenger',
              body: voiceEnvelope ? 'Voice message' : 'New message',
            }).catch(() => {});
          }
        } catch {
          // Tampered/invalid ciphertext, wrong epoch, or any other
          // authentication failure. Never fall back to displaying raw
          // ciphertext or any guessed content — record an explicit
          // failure state the UI renders as such.
          if (getMessageStoreOwner() !== owner) return;
          recordMessage(owner, {
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: 'incoming',
            status: 'decryption_failed',
            plaintext: null,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });
        }
        changed = true;
        newestProcessedAt = row.createdAt;
      }

      if (getMessageStoreOwner() !== owner) return;
      // Rows arrive oldest first, so this is the newest one handled. The
      // cursor only moves once every row up to it has been processed.
      if (newestProcessedAt && (!cursor || newestProcessedAt > cursor)) {
        setSyncCursor(owner, conversationId, newestProcessedAt);
      }
      if (changed) {
        refreshConversationPreview(owner, conversationId);
        notifyConversationChanged(conversationId);
      }
    },
    [deviceId],
  );

  /**
   * One sync per conversation at a time. The chat screen's interval, the
   * conversation-list refresh and a returning-to-foreground refresh can all
   * ask for the same conversation while a sync is still in flight (slow
   * network, a long first sync); instead of overlapping requests and
   * decrypt attempts, the later request is folded into a single follow-up
   * sync once the running one finishes, and every caller's promise
   * resolves after data at least as new as its request.
   */
  const syncStateRef = useRef(new Map<string, { running: Promise<void>; again: boolean }>());

  const pollConversation = useCallback(
    (conversationId: string): Promise<void> => {
      const states = syncStateRef.current;
      const inFlight = states.get(conversationId);
      if (inFlight) {
        inFlight.again = true;
        return inFlight.running;
      }
      const state = { running: Promise.resolve(), again: false };
      state.running = (async () => {
        try {
          do {
            state.again = false;
            await syncConversation(conversationId);
          } while (state.again);
        } finally {
          states.delete(conversationId);
        }
      })();
      states.set(conversationId, state);
      return state.running;
    },
    [syncConversation],
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

    // Catches a Welcome for a conversation someone just started with us,
    // even before we've opened it — keeps the chat list showing
    // conversations as usable (joined) without requiring the user to
    // tap in first.
    for (const row of remote) {
      if (getMessageStoreOwner() !== owner) return;
      if (!isConversationJoined(owner, row.conversationId)) {
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
    ensureE2eeSetup();
  }, [status, ensureE2eeSetup]);

  useEffect(() => {
    if (status !== 'authenticated' || !e2eeReady) return;
    refreshConversations();

    // Audit fix: this previously polled every CONVERSATIONS_POLL_MS
    // unconditionally, including while the app is backgrounded — a real,
    // cumulative battery/network cost with no push/realtime transport in
    // this app. Pausing the interval while AppState isn't 'active' (and
    // refreshing once immediately on returning to foreground, so the
    // list isn't stale on resume) removes that cost with no change to
    // foreground behavior.
    let ticks = 0;
    const poll = () => {
      ticks += 1;
      if (realtime.getStatus() === 'online' && ticks % ONLINE_POLL_EVERY !== 0) return;
      void refreshConversations();
    };
    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(poll, CONVERSATIONS_POLL_MS);
    };
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    if (AppState.currentState === 'active') startInterval();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refreshConversations();
        startInterval();
      } else {
        stopInterval();
      }
    });

    return () => {
      stopInterval();
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
      if (owner && isConversationJoined(owner, event.conversationId)) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Captures `owner` once at entry and re-checks it after every `await`
   * (via `requireStillOwner`) before writing to messageStore or
   * publishing trust material under that account — see `syncConversation`
   * for the same pattern and rationale. A stale check throws, aborting
   * the rest of this call; the caller (`startConversation`'s wrapper)
   * already removes this from the in-flight map in its own `finally`.
   */
  const startConversationImpl = useCallback(
    async (otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string> => {
      const owner = getMessageStoreOwner();
      if (!owner) throw new Error('You are not signed in.');
      const requireStillOwner = () => {
        if (getMessageStoreOwner() !== owner) {
          throw new Error('Signed out before this could finish.');
        }
      };

      const { conversationId } = await e2eeApi.createConversation({ otherUserId });
      requireStillOwner();
      upsertConversation(owner, {
        id: conversationId,
        otherUserId,
        otherUsername,
        otherDisplayName,
        createdAt: nowIso(),
      });

      if (!isConversationJoined(owner, conversationId)) {
        const groupIdBytes = uuidToBytes(conversationId);
        // A previous attempt at this same conversation can have created
        // the local MLS group and then failed at a later step (recipient
        // had no active device yet, network drop, etc.) — OpenMLS's group
        // storage is keyed by group id and rejects re-creating one that
        // already exists locally, so a naive retry would call createGroup
        // again here and fail permanently. Guard it with the same
        // local-flag idempotency pattern used for KeyPackage publishing.
        //
        // Scoped by `owner`, unlike app_state's other flags (e.g.
        // welcome_processed:<messageId>), which are deliberately global —
        // see messageStore.ts's module doc. Those are safe unscoped
        // because they represent server-side state that's the same
        // regardless of which local account checks it. This flag is
        // different: it gates a per-account native operation (OpenMLS
        // group storage is namespaced per user — see mls-core's
        // getOrCreateMasterKey/storage-open, keyed by userId). Without
        // the owner in the key, one account's successful createGroup()
        // would set a flag that a DIFFERENT account (logged into on the
        // same device, e.g. during multi-account testing) would then
        // read as "already created" and skip its own createGroup() —
        // leaving that account's local MLS store without the group at
        // all, so the later addMemberToGroup() call fails with
        // GroupNotFound. Reproduced exactly this way: switching between
        // two accounts on one device while both had pending invites to
        // the same conversation id.
        const groupCreatedFlagKey = `groupCreated:${owner}:${conversationId}`;
        if (getAppState(groupCreatedFlagKey) !== 'true') {
          await createGroup(groupIdBytes);
          requireStillOwner();
          setAppState(groupCreatedFlagKey, 'true');
        }

        const deviceIds = await e2eeApi.listActiveDeviceIds({ userId: otherUserId });
        requireStillOwner();
        if (deviceIds.length === 0) {
          throw new Error(`${otherDisplayName} hasn't set up encrypted messaging on any device yet.`);
        }

        let invitedAny = false;
        for (const targetDeviceId of deviceIds) {
          const { keyPackage } = await e2eeApi.consumeKeyPackage({ targetDeviceId });
          requireStillOwner();
          if (!keyPackage) continue; // no KeyPackage available for this device right now — best-effort, skip it
          const welcomeBytes = await addMemberToGroup(groupIdBytes, base64ToBytes(keyPackage));
          requireStillOwner();
          await e2eeApi.sendMessage({
            conversationId,
            ciphertext: bytesToBase64(welcomeBytes),
            messageType: 'welcome',
            recipientDeviceId: targetDeviceId,
          });
          invitedAny = true;
        }

        if (!invitedAny) {
          throw new Error(`${otherDisplayName}'s device isn't ready to receive encrypted messages yet. Try again shortly.`);
        }

        requireStillOwner();
        markConversationJoined(owner, conversationId);
      }

      requireStillOwner();
      applyConversations(listLocalConversations(owner));
      return conversationId;
    },
    // applyConversations is stable (no dependencies).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const attemptSend = useCallback(
    async (conversationId: string, localId: string, text: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      try {
        const groupIdBytes = uuidToBytes(conversationId);
        const ciphertext = await encryptMessage(groupIdBytes, text);
        const { messageId, createdAt } = await e2eeApi.sendMessage({
          conversationId,
          ciphertext: bytesToBase64(ciphertext),
          messageType: 'application',
        });
        if (getMessageStoreOwner() !== owner) return; // sent server-side either way; local reconcile only applies under the account that sent it
        // The server's own timestamp when it returns one (older servers
        // don't), so ordering is right before the next sync confirms it.
        reconcileSentMessageId(owner, localId, messageId, createdAt ?? nowIso());
      } catch {
        if (getMessageStoreOwner() !== owner) return;
        updateMessageStatus(owner, localId, 'failed');
      }
      if (getMessageStoreOwner() !== owner) return;
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
    },
    [deviceId],
  );

  /**
   * Mirrors `attemptSend` exactly (same owner-capture-and-recheck-after-
   * every-await pattern), but for a voice message's two-part send: the
   * audio blob is encrypted with the SAME `encryptMessage` call used for
   * ordinary text (no native/crypto changes — see the design note in the
   * project plan) and uploaded as opaque bytes to the REST media
   * endpoint; a small JSON envelope (mediaId + duration) is then sent
   * through the existing `sendMessage` path, exactly like a text
   * message. The local optimistic row already has `audioLocalUri`
   * pointing at the just-recorded file (see `sendVoiceMessage`), so the
   * sender's own bubble is playable immediately — this function's only
   * job is to get the blob+metadata to the server and reconcile the
   * local id, never to make audio playable locally (it already is).
   */
  const attemptSendVoice = useCallback(
    async (conversationId: string, localId: string, localFileUri: string, durationMs: number): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      try {
        const bytes = await readAudioBytes(localFileUri);
        if (getMessageStoreOwner() !== owner) return;
        const groupIdBytes = uuidToBytes(conversationId);

        // Audit fix: reuse a mediaId from a prior attempt instead of
        // re-uploading. If a previous call reached uploadVoiceBlob
        // successfully but then failed before/at sendMessage (network
        // drop, app killed), `mediaId` below is already persisted on
        // this row — without this check, every retry re-encrypted and
        // re-uploaded the same audio under a brand-new mediaId, leaving
        // each earlier upload permanently orphaned on the server (no
        // message ever ends up referencing it, and there is no
        // garbage-collection job for unreferenced blobs).
        const existingRow = getMessageById(owner, localId);
        let mediaId = existingRow?.audioMediaId ?? null;
        if (!mediaId) {
          const blobCiphertext = await encryptMessage(groupIdBytes, bytesToBase64(bytes));
          if (getMessageStoreOwner() !== owner) return;
          const uploaded = await uploadVoiceBlob(conversationId, blobCiphertext);
          if (getMessageStoreOwner() !== owner) return;
          mediaId = uploaded.mediaId;
          setVoiceMediaId(owner, localId, mediaId);
        }

        const envelope = buildVoiceEnvelope({ mediaId, durationMs, byteSize: bytes.length, mimeType: 'audio/m4a' });
        const metadataCiphertext = await encryptMessage(groupIdBytes, envelope);
        if (getMessageStoreOwner() !== owner) return;
        const { messageId, createdAt } = await e2eeApi.sendMessage({
          conversationId,
          ciphertext: bytesToBase64(metadataCiphertext),
          messageType: 'application',
        });
        if (getMessageStoreOwner() !== owner) return; // sent server-side either way; local reconcile only applies under the account that sent it
        reconcileSentMessageId(owner, localId, messageId, createdAt ?? nowIso());
      } catch {
        if (getMessageStoreOwner() !== owner) return;
        updateMessageStatus(owner, localId, 'failed');
      }
      if (getMessageStoreOwner() !== owner) return;
      refreshConversationPreview(owner, conversationId);
      notifyConversationChanged(conversationId);
    },
    [deviceId],
  );

  const sendChatMessage = useCallback(
    async (conversationId: string, text: string): Promise<void> => {
      const owner = getMessageStoreOwner();
      if (!deviceId || !owner) return;
      if (!isConversationJoined(owner, conversationId)) {
        throw new Error('This conversation is not ready to send messages yet.');
      }
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
    [deviceId, attemptSend],
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
      if (!isConversationJoined(owner, conversationId)) {
        throw new Error('This conversation is not ready to send messages yet.');
      }
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
    [deviceId, attemptSendVoice],
  );

  /**
   * Lazily fetches+decrypts a received voice message's audio blob on
   * first playback (never eagerly on receipt — see `syncConversation`'s
   * `audioState: 'idle'`), then caches the decrypted bytes to a local
   * file so replaying the same message never re-downloads/re-decrypts.
   * A concurrent second call for the same message (e.g. a double tap)
   * bails immediately once it sees `audioState` is already
   * 'downloading'/'downloaded' — decrypting the same MLS ciphertext
   * twice is not safe (see mlsCore.ts), so this must never be attempted.
   */
  const downloadVoiceMessage = useCallback(async (conversationId: string, messageId: string): Promise<void> => {
    const owner = getMessageStoreOwner();
    if (!owner) return;
    const row = getMessageById(owner, messageId);
    if (!row || row.kind !== 'voice' || !row.audioMediaId) return;
    if (row.audioState === 'downloading' || row.audioState === 'downloaded') return;

    updateVoiceAudio(owner, messageId, { audioState: 'downloading' });
    notifyConversationChanged(conversationId);

    try {
      const blobCiphertext = await downloadVoiceBlob(conversationId, row.audioMediaId);
      if (getMessageStoreOwner() !== owner) return;
      const groupIdBytes = uuidToBytes(conversationId);
      const base64Audio = await decryptMessage(groupIdBytes, blobCiphertext);
      if (getMessageStoreOwner() !== owner) return;
      const uri = writeDownloadedAudio(owner, conversationId, row.audioMediaId, base64ToBytes(base64Audio));
      if (getMessageStoreOwner() !== owner) return;
      updateVoiceAudio(owner, messageId, { audioLocalUri: uri, audioState: 'downloaded' });
    } catch {
      if (getMessageStoreOwner() !== owner) return;
      updateVoiceAudio(owner, messageId, { audioState: 'failed' });
    }
    if (getMessageStoreOwner() !== owner) return;
    notifyConversationChanged(conversationId);
  }, []);

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
