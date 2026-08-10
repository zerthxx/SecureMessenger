import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import type { Conversation, Message } from '@/domain/entities';
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
import {
  getAppState,
  getMessageById,
  initMessageStore,
  isConversationJoined,
  listLocalConversations,
  listMessagesForConversation,
  markConversationJoined,
  recordMessage,
  reconcileSentMessageId,
  refreshConversationPreview,
  setAppState,
  updateMessageStatus,
  upsertConversation,
  type MessageRow,
} from '@/infrastructure/storage/messageStore';
import { useAuth } from '@/ui/screens/auth/AuthContext';

const KEY_PACKAGE_BATCH_SIZE = 20;
const CONVERSATIONS_POLL_MS = 6000;

function nowIso(): string {
  return new Date().toISOString();
}

function randomLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toMessage(row: MessageRow): Message {
  // Outgoing messages (sending/sent/failed) always store our own
  // authored plaintext and it's always safe to display it. Incoming
  // messages only ever have real plaintext once `status === 'decrypted'`
  // — `decryption_failed` rows have `plaintext === null` regardless of
  // direction, so this single check covers both correctly: never
  // surface text for a failed decryption, always surface it otherwise.
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderDeviceId: row.senderDeviceId,
    direction: row.direction,
    status: row.status,
    text: row.status === 'decryption_failed' ? null : row.plaintext,
    createdAt: row.createdAt,
  };
}

interface UserSearchResult {
  id: string;
  username: string;
  displayName: string;
}

interface ChatContextValue {
  conversations: Conversation[];
  e2eeReady: boolean;
  e2eeError: string | null;
  refreshConversations(): Promise<void>;
  startConversation(otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string>;
  getMessages(conversationId: string): Message[];
  pollConversation(conversationId: string): Promise<void>;
  sendChatMessage(conversationId: string, text: string): Promise<void>;
  retryMessage(conversationId: string, messageId: string): Promise<void>;
  searchUsers(query: string): Promise<UserSearchResult[]>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { status, deviceId, user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [e2eeReady, setE2eeReady] = useState(false);
  const [e2eeError, setE2eeError] = useState<string | null>(null);
  // Bumped after any local-store write so screens reading getMessages()
  // re-render — the SQLite store itself has no subscription mechanism.
  const [messagesVersion, setMessagesVersion] = useState(0);

  useEffect(() => {
    initMessageStore();
  }, []);

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
   */
  const ensureE2eeSetup = useCallback(async (): Promise<void> => {
    if (!deviceId || !user) return;
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
    }
  }, [deviceId, user]);

  /**
   * Looks for a Welcome message addressed to this device and, for
   * already-joined groups, decrypts any new application messages.
   * Safe to call repeatedly and concurrently with itself for the same
   * conversation — every non-idempotent step (join, decrypt) is guarded
   * by an "already processed" check against the local store first.
   */
  const pollConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (!deviceId) return;
      let rows: Awaited<ReturnType<typeof e2eeApi.fetchMessages>>;
      try {
        rows = await e2eeApi.fetchMessages({ conversationId });
      } catch {
        return; // network/server failure this cycle — next poll will retry
      }

      const groupIdBytes = uuidToBytes(conversationId);

      for (const row of rows) {
        const existing = getMessageById(row.id);

        if (row.messageType === 'welcome') {
          if (getAppState(`welcome_processed:${row.id}`) === '1') continue;
          try {
            await joinGroupFromWelcome(base64ToBytes(row.ciphertext));
            markConversationJoined(conversationId);
          } catch {
            // Already joined (e.g. this device processed it in an
            // earlier session before the flag was recorded) or a
            // malformed Welcome — either way, nothing more to do with
            // this specific message.
          }
          setAppState(`welcome_processed:${row.id}`, '1');
          continue;
        }

        // application message
        const alreadyProcessed = existing !== null && existing.status !== 'sending';
        if (alreadyProcessed) {
          // Reconcile ordering/metadata only — recordMessage's upsert
          // never overwrites an already-decrypted plaintext.
          recordMessage({
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: row.senderDeviceId === deviceId ? 'outgoing' : 'incoming',
            status: existing!.status,
            plaintext: existing!.plaintext,
            createdAt: row.createdAt,
            localCreatedAt: existing!.localCreatedAt,
          });
          continue;
        }

        if (row.senderDeviceId === deviceId) {
          // Our own message, not found locally (e.g. local cache lost).
          // MLS erases a sent generation's key material right after
          // use — this device cannot recover its own past plaintext.
          recordMessage({
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: 'outgoing',
            status: 'decryption_failed',
            plaintext: null,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });
          continue;
        }

        try {
          const plaintext = await decryptMessage(groupIdBytes, base64ToBytes(row.ciphertext));
          recordMessage({
            id: row.id,
            conversationId,
            senderDeviceId: row.senderDeviceId,
            direction: 'incoming',
            status: 'decrypted',
            plaintext,
            createdAt: row.createdAt,
            localCreatedAt: row.createdAt,
          });
        } catch {
          // Tampered/invalid ciphertext, wrong epoch, or any other
          // authentication failure. Never fall back to displaying raw
          // ciphertext or any guessed content — record an explicit
          // failure state the UI renders as such.
          recordMessage({
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
      }

      refreshConversationPreview(conversationId);
      setMessagesVersion((v) => v + 1);
    },
    [deviceId],
  );

  const refreshConversations = useCallback(async (): Promise<void> => {
    let remote: Awaited<ReturnType<typeof e2eeApi.listConversations>>;
    try {
      remote = await e2eeApi.listConversations();
    } catch {
      setConversations(listLocalConversations());
      return;
    }

    for (const row of remote) {
      upsertConversation({
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
      if (!isConversationJoined(row.conversationId)) {
        await pollConversation(row.conversationId);
      }
    }

    setConversations(listLocalConversations());
  }, [pollConversation]);

  useEffect(() => {
    if (status !== 'authenticated') {
      setE2eeReady(false);
      return;
    }
    ensureE2eeSetup();
  }, [status, ensureE2eeSetup]);

  useEffect(() => {
    if (status !== 'authenticated' || !e2eeReady) return;
    refreshConversations();
    const id = setInterval(refreshConversations, CONVERSATIONS_POLL_MS);
    return () => clearInterval(id);
    // refreshConversations is stable enough (recreated only when
    // pollConversation's deviceId dependency changes) for this interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, e2eeReady]);

  const startConversation = useCallback(
    async (otherUserId: string, otherUsername: string, otherDisplayName: string): Promise<string> => {
      const { conversationId } = await e2eeApi.createConversation({ otherUserId });
      upsertConversation({
        id: conversationId,
        otherUserId,
        otherUsername,
        otherDisplayName,
        createdAt: nowIso(),
      });

      if (!isConversationJoined(conversationId)) {
        const groupIdBytes = uuidToBytes(conversationId);
        // A previous attempt at this same conversation can have created
        // the local MLS group and then failed at a later step (recipient
        // had no active device yet, network drop, etc.) — OpenMLS's group
        // storage is keyed by group id and rejects re-creating one that
        // already exists locally, so a naive retry would call createGroup
        // again here and fail permanently. Guard it with the same
        // local-flag idempotency pattern used for KeyPackage publishing.
        const groupCreatedFlagKey = `groupCreated:${conversationId}`;
        if (getAppState(groupCreatedFlagKey) !== 'true') {
          await createGroup(groupIdBytes);
          setAppState(groupCreatedFlagKey, 'true');
        }

        const deviceIds = await e2eeApi.listActiveDeviceIds({ userId: otherUserId });
        if (deviceIds.length === 0) {
          throw new Error(`${otherDisplayName} hasn't set up encrypted messaging on any device yet.`);
        }

        let invitedAny = false;
        for (const targetDeviceId of deviceIds) {
          const { keyPackage } = await e2eeApi.consumeKeyPackage({ targetDeviceId });
          if (!keyPackage) continue; // no KeyPackage available for this device right now — best-effort, skip it
          const welcomeBytes = await addMemberToGroup(groupIdBytes, base64ToBytes(keyPackage));
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

        markConversationJoined(conversationId);
      }

      setConversations(listLocalConversations());
      return conversationId;
    },
    [],
  );

  const attemptSend = useCallback(
    async (conversationId: string, localId: string, text: string): Promise<void> => {
      if (!deviceId) return;
      try {
        const groupIdBytes = uuidToBytes(conversationId);
        const ciphertext = await encryptMessage(groupIdBytes, text);
        const { messageId } = await e2eeApi.sendMessage({
          conversationId,
          ciphertext: bytesToBase64(ciphertext),
          messageType: 'application',
        });
        reconcileSentMessageId(localId, messageId, nowIso());
      } catch {
        updateMessageStatus(localId, 'failed');
      }
      refreshConversationPreview(conversationId);
      setMessagesVersion((v) => v + 1);
    },
    [deviceId],
  );

  const sendChatMessage = useCallback(
    async (conversationId: string, text: string): Promise<void> => {
      if (!deviceId) return;
      if (!isConversationJoined(conversationId)) {
        throw new Error('This conversation is not ready to send messages yet.');
      }
      const localId = randomLocalId();
      const timestamp = nowIso();
      recordMessage({
        id: localId,
        conversationId,
        senderDeviceId: deviceId,
        direction: 'outgoing',
        status: 'sending',
        plaintext: text,
        createdAt: timestamp,
        localCreatedAt: timestamp,
      });
      refreshConversationPreview(conversationId);
      setMessagesVersion((v) => v + 1);
      await attemptSend(conversationId, localId, text);
    },
    [deviceId, attemptSend],
  );

  const retryMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      const row = getMessageById(messageId);
      if (!row || row.plaintext === null) return;
      updateMessageStatus(messageId, 'sending');
      setMessagesVersion((v) => v + 1);
      await attemptSend(conversationId, messageId, row.plaintext);
    },
    [attemptSend],
  );

  // Re-created whenever messagesVersion bumps, so screens calling
  // getMessages() after a store write see fresh results — the SQLite
  // store itself has no subscription mechanism to hook into.
  const getMessages = useCallback(
    (conversationId: string): Message[] => listMessagesForConversation(conversationId).map(toMessage),
    [messagesVersion],
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
      refreshConversations,
      startConversation,
      getMessages,
      pollConversation,
      sendChatMessage,
      retryMessage,
      searchUsers,
    }),
    [
      conversations,
      e2eeReady,
      e2eeError,
      refreshConversations,
      startConversation,
      getMessages,
      pollConversation,
      sendChatMessage,
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
