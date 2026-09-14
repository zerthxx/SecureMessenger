import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { router, type Href } from 'expo-router';

import CallSessionNative from '../../../../modules/call-session/src';
import type { ServerEvent } from '../../../../server/src/realtime/protocol';
import { CallSession, type CallState } from '@/infrastructure/calls/callSession';
import { openSignal, type CallMediaKind } from '@/infrastructure/calls/callSignaling';
import { ensureMlsCoreInitialized } from '@/infrastructure/crypto/mlsCore';
import { realtime } from '@/infrastructure/realtime/realtimeClient';
import { getConversation, getMessageStoreOwner } from '@/infrastructure/storage/messageStore';
import { useAuth } from '@/ui/screens/auth/AuthContext';

/** How long the "Call ended" state stays on screen. */
const ENDED_DISPLAY_MS = 1800;
/** In the background incoming calls arrive by push, so the socket is closed after this (unless a call is running). */
const BACKGROUND_DISCONNECT_MS = 5000;
/**
 * A sealed offer older than this is a replay or hopelessly late. Generous
 * enough for clock differences between phones; the server itself only
 * relays calls that are still ringing.
 */
const OFFER_MAX_AGE_MS = 5 * 60 * 1000;

export interface CallContextValue {
  call: CallState | null;
  startCall(conversationId: string, media: CallMediaKind): Promise<void>;
  accept(): void;
  decline(): void;
  hangup(): void;
  toggleMute(): void;
  toggleCamera(): void;
  toggleSpeaker(): void;
  switchCamera(): void;
  /** Handles a `securemessenger://call?callId=…&action=…` link from a call notification. */
  handleCallLink(callId: string, action: string | undefined): void;
}

const CallContext = createContext<CallContextValue | null>(null);

type IncomingEvent = Extract<ServerEvent, { type: 'call.incoming' }>;

export function CallProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { status, user } = useAuth();
  const [call, setCall] = useState<CallState | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  /** Invites already acted on — a duplicate delivery (live + fetched after a push) never rings twice. */
  const seenCallIds = useRef(new Set<string>());
  /** Events for a call whose invite is still being verified. */
  const earlyEvents = useRef(new Map<string, ServerEvent[]>());
  /** Accept/decline chosen on a notification before the invite has been fetched. */
  const pendingActions = useRef(new Map<string, 'accept' | 'decline'>());

  const activeSession = () => {
    const session = sessionRef.current;
    return session?.isActive ? session : null;
  };

  const adopt = useCallback((session: CallSession) => {
    sessionRef.current = session;
    setCall(session.snapshot);
    const unsubscribe = session.subscribe((state) => {
      if (sessionRef.current !== session) return;
      setCall(state);
      if (state.phase !== 'ended') return;
      unsubscribe();
      if (AppState.currentState !== 'active') realtime.stop();
      setTimeout(() => {
        if (sessionRef.current !== session) return;
        sessionRef.current = null;
        setCall(null);
      }, ENDED_DISPLAY_MS);
    });
    router.push('/call' as Href);
  }, []);

  // The realtime socket: connected while signed in and in the foreground,
  // and for as long as a call is running.
  useEffect(() => {
    if (status !== 'authenticated') {
      realtime.stop();
      return;
    }
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    const apply = (appState: AppStateStatus) => {
      activeSession()?.setBackgrounded(appState !== 'active');
      if (appState === 'active') {
        if (stopTimer) clearTimeout(stopTimer);
        stopTimer = null;
        realtime.start();
        return;
      }
      if (activeSession() || stopTimer) return;
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (!activeSession() && AppState.currentState !== 'active') realtime.stop();
      }, BACKGROUND_DISCONNECT_MS);
    };
    apply(AppState.currentState);
    const subscription = AppState.addEventListener('change', apply);
    return () => {
      subscription.remove();
      if (stopTimer) clearTimeout(stopTimer);
      activeSession()?.hangup();
      realtime.stop();
    };
  }, [status]);

  const handleIncoming = useCallback(
    async (event: IncomingEvent) => {
      if (seenCallIds.current.has(event.callId)) return;
      seenCallIds.current.add(event.callId);
      earlyEvents.current.set(event.callId, []);
      try {
        const owner = getMessageStoreOwner();
        const conversation = owner ? getConversation(owner, event.conversationId) : null;
        if (!owner || !conversation?.groupJoined || !userIdRef.current) return;
        await ensureMlsCoreInitialized(userIdRef.current);

        // Ring only for an offer sealed by a member of this conversation, for
        // this call, recently: the server alone can't make this phone ring.
        const offer = await openSignal(event.conversationId, event.callId, event.payload);
        if (
          offer?.kind !== 'offer' ||
          offer.restart ||
          offer.media !== event.media ||
          Math.abs(Date.now() - offer.sentAt) > OFFER_MAX_AGE_MS
        ) {
          return;
        }

        if (activeSession()) {
          realtime.send({ type: 'call.decline', callId: event.callId, busy: true });
          return;
        }

        const session = CallSession.incoming({
          callId: event.callId,
          conversationId: event.conversationId,
          peerName: conversation.otherDisplayName,
          media: event.media,
          offerSdp: offer.sdp,
        });
        realtime.send({ type: 'call.ringing', callId: event.callId });
        adopt(session);
        for (const early of earlyEvents.current.get(event.callId) ?? []) session.handleServerEvent(early);

        const action = pendingActions.current.get(event.callId);
        pendingActions.current.delete(event.callId);
        if (action === 'accept') {
          void session.accept();
        } else if (action === 'decline') {
          session.decline();
        } else if (AppState.currentState === 'active') {
          void CallSessionNative.startRinging().catch(() => {});
        } else {
          void CallSessionNative.showIncomingCall(event.callId, conversation.otherDisplayName, event.media === 'video').catch(() => {});
        }
      } finally {
        earlyEvents.current.delete(event.callId);
      }
    },
    [adopt],
  );

  useEffect(() => {
    if (status !== 'authenticated') return;
    return realtime.onEvent((event) => {
      if (!event.type.startsWith('call.') || !('callId' in event) || !event.callId) return;
      if (event.type === 'call.incoming') {
        void handleIncoming(event);
        return;
      }
      const buffered = earlyEvents.current.get(event.callId);
      if (buffered) {
        buffered.push(event);
        return;
      }
      const session = sessionRef.current;
      if (session?.snapshot.callId === event.callId) session.handleServerEvent(event);
    });
  }, [status, handleIncoming]);

  // An incoming call interrupted by another app taking the audio (a regular
  // phone call) mutes the microphone until the audio comes back.
  useEffect(() => {
    const subscription = CallSessionNative.addListener('onAudioFocusChange', ({ focused }) => {
      const session = activeSession();
      if (session && session.snapshot.phase !== 'incoming') session.setMicMuted(!focused);
    });
    return () => subscription.remove();
  }, []);

  const startCall = useCallback(
    async (conversationId: string, media: CallMediaKind) => {
      if (activeSession()) {
        router.push('/call' as Href);
        return;
      }
      const owner = getMessageStoreOwner();
      const conversation = owner ? getConversation(owner, conversationId) : null;
      if (!conversation?.groupJoined) {
        throw new Error('Encryption for this chat is still being set up. Try again in a moment.');
      }
      realtime.start();
      const session = CallSession.outgoing({ conversationId, peerName: conversation.otherDisplayName, media });
      adopt(session);
      await session.start();
    },
    [adopt],
  );

  const handleCallLink = useCallback((callId: string, action: string | undefined) => {
    void CallSessionNative.dismissIncomingCall(callId).catch(() => {});
    const session = sessionRef.current;
    if (session?.snapshot.callId === callId) {
      if (action === 'accept') void session.accept();
      else if (action === 'decline') session.decline();
      else if (action === 'hangup') session.hangup();
      return;
    }
    if (action === 'hangup') return;
    if (action === 'accept' || action === 'decline') pendingActions.current.set(callId, action);
    // Woken by a push: fetch the invite this device missed while disconnected.
    seenCallIds.current.delete(callId);
    realtime.start();
    realtime.send({ type: 'call.fetch', callId });
  }, []);

  const value = useMemo<CallContextValue>(
    () => ({
      call,
      startCall,
      accept: () => void activeSession()?.accept(),
      decline: () => activeSession()?.decline(),
      hangup: () => activeSession()?.hangup(),
      toggleMute: () => {
        const session = activeSession();
        if (session) session.setMicMuted(!session.snapshot.micMuted);
      },
      toggleCamera: () => {
        const session = activeSession();
        if (session) session.setCameraOff(!session.snapshot.cameraOff);
      },
      toggleSpeaker: () => {
        const session = activeSession();
        if (session) void session.setSpeaker(!session.snapshot.speakerOn);
      },
      switchCamera: () => void activeSession()?.switchCamera(),
      handleCallLink,
    }),
    [call, startCall, handleCallLink],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return ctx;
}
