import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, type MediaStream } from 'react-native-webrtc';

import CallSessionNative from '../../../modules/call-session/src';
import type { ServerEvent } from '../../../server/src/realtime/protocol';
import { callsApi } from '@/infrastructure/network/trpcClient';
import { realtime } from '@/infrastructure/realtime/realtimeClient';
import { newCallId, openLocalMedia, releaseStream, requestCallPermissions } from './callMedia';
import { openSignal, sealSignal, type CallMediaKind, type CallSignal } from './callSignaling';

export type CallDirection = 'outgoing' | 'incoming';
export type CallPhase = 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

export type CallEndReason =
  | 'hangup'
  | 'remote_hangup'
  | 'declined'
  | 'busy'
  | 'no_answer'
  | 'missed'
  | 'answered_elsewhere'
  | 'connection_lost'
  | 'permission_denied'
  | 'unavailable'
  | 'failed';

export interface CallState {
  callId: string;
  conversationId: string;
  peerName: string;
  direction: CallDirection;
  media: CallMediaKind;
  phase: CallPhase;
  endReason: CallEndReason | null;
  /** The callee's device is showing the call (outgoing calls). */
  remoteRinging: boolean;
  connectedAt: number | null;
  micMuted: boolean;
  cameraOff: boolean;
  speakerOn: boolean;
  frontCamera: boolean;
  remoteMicMuted: boolean;
  remoteCameraOff: boolean;
  localStreamUrl: string | null;
  remoteStreamUrl: string | null;
}

/** ICE "disconnected" for this long (a network switch, a tunnel) triggers an ICE restart. */
const RECONNECT_AFTER_MS = 3_000;
/** A call that hasn't (re)connected within this long is ended. */
const GIVE_UP_AFTER_MS = 30_000;

class PermissionDeniedError extends Error {}

/** The RTCPeerConnection events used below (see createPeerConnection for why they're declared here). */
interface PeerConnectionEvents {
  addEventListener(type: 'icecandidate', listener: (event: { candidate: RTCIceCandidate | null }) => void): void;
  addEventListener(type: 'track', listener: (event: { streams: MediaStream[] }) => void): void;
  addEventListener(type: 'iceconnectionstatechange' | 'connectionstatechange', listener: () => void): void;
}

type ServerCallEnd = Extract<ServerEvent, { type: 'call.ended' }>['reason'];

function endReasonFor(reason: ServerCallEnd, direction: CallDirection): CallEndReason {
  switch (reason) {
    case 'hangup':
      return 'remote_hangup';
    case 'cancelled':
      return direction === 'incoming' ? 'missed' : 'hangup';
    case 'timeout':
      return direction === 'outgoing' ? 'no_answer' : 'missed';
    case 'declined':
      return 'declined';
    case 'busy':
      return 'busy';
    case 'connection_lost':
      return 'connection_lost';
    case 'answered_elsewhere':
    case 'declined_elsewhere':
      return 'answered_elsewhere';
  }
}

/**
 * One call, from ringing to cleanup: local media, the RTCPeerConnection
 * (DTLS-SRTP media, peer to peer or through TURN), and signaling over the
 * realtime socket with every SDP/ICE payload sealed by the conversation's
 * MLS group. UI-agnostic — CallContext renders its state.
 *
 * Ordering rules that matter:
 * - The invite/answer is queued for sending before the local description is
 *   applied, so the other side never receives ICE candidates for a call or
 *   answer it doesn't know about yet.
 * - Received signals are processed strictly in order; candidates that
 *   arrive before the remote description are held until it is set.
 * - Only the caller sends offers (also for ICE restarts), so the two sides
 *   never renegotiate over each other.
 */
export class CallSession {
  private state: CallState;
  private readonly listeners = new Set<(state: CallState) => void>();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteDescriptionSet = false;
  private heldCandidates: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }[] = [];
  private remoteOfferSdp: string | null = null;
  private sending: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private backgrounded = false;
  private finished = false;

  private constructor(init: Pick<CallState, 'callId' | 'conversationId' | 'peerName' | 'direction' | 'media' | 'phase'>) {
    this.state = {
      ...init,
      endReason: null,
      remoteRinging: false,
      connectedAt: null,
      micMuted: false,
      cameraOff: false,
      speakerOn: init.media === 'video',
      frontCamera: true,
      remoteMicMuted: false,
      remoteCameraOff: false,
      localStreamUrl: null,
      remoteStreamUrl: null,
    };
  }

  static outgoing(input: { conversationId: string; peerName: string; media: CallMediaKind }): CallSession {
    return new CallSession({ ...input, callId: newCallId(), direction: 'outgoing', phase: 'outgoing' });
  }

  static incoming(input: { callId: string; conversationId: string; peerName: string; media: CallMediaKind; offerSdp: string }): CallSession {
    const session = new CallSession({
      callId: input.callId,
      conversationId: input.conversationId,
      peerName: input.peerName,
      media: input.media,
      direction: 'incoming',
      phase: 'incoming',
    });
    session.remoteOfferSdp = input.offerSdp;
    return session;
  }

  get snapshot(): CallState {
    return this.state;
  }

  get isActive(): boolean {
    return this.state.phase !== 'ended';
  }

  subscribe(listener: (state: CallState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Caller: opens media, creates the offer and rings the other side. */
  async start(): Promise<void> {
    try {
      const { iceServers } = await callsApi.iceServers();
      await this.openMedia();
      const pc = this.createPeerConnection(iceServers);
      const offer = await pc.createOffer({});
      if (this.finished) return;
      const sdp = offer.sdp ?? '';
      this.enqueueSend(async () => {
        const payload = await sealSignal(this.state.conversationId, this.state.callId, {
          kind: 'offer',
          sdp,
          media: this.state.media,
          sentAt: Date.now(),
          restart: false,
        });
        realtime.send({
          type: 'call.invite',
          callId: this.state.callId,
          conversationId: this.state.conversationId,
          media: this.state.media,
          payload,
        });
      });
      await pc.setLocalDescription(offer);
      await CallSessionNative.startAudio(this.state.speakerOn);
    } catch (err) {
      this.end(err instanceof PermissionDeniedError ? 'permission_denied' : 'failed', true);
    }
  }

  /** Callee: opens media and answers the offer that came with the invite. */
  async accept(): Promise<void> {
    if (this.state.phase !== 'incoming' || !this.remoteOfferSdp) return;
    const offerSdp = this.remoteOfferSdp;
    this.update({ phase: 'connecting' });
    void CallSessionNative.stopRinging().catch(() => {});
    void CallSessionNative.dismissIncomingCall(this.state.callId).catch(() => {});
    try {
      const { iceServers } = await callsApi.iceServers();
      await this.openMedia();
      const pc = this.createPeerConnection(iceServers);
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
      this.remoteDescriptionSet = true;
      await this.addHeldCandidates();
      const answer = await pc.createAnswer();
      if (this.finished) return;
      const sdp = answer.sdp ?? '';
      this.enqueueSend(async () => {
        const payload = await sealSignal(this.state.conversationId, this.state.callId, { kind: 'answer', sdp });
        realtime.send({ type: 'call.accept', callId: this.state.callId, payload });
      });
      await pc.setLocalDescription(answer);
      await CallSessionNative.startAudio(this.state.speakerOn);
    } catch (err) {
      this.end(err instanceof PermissionDeniedError ? 'permission_denied' : 'failed', true);
    }
  }

  decline(): void {
    if (this.state.phase !== 'incoming') return;
    realtime.send({ type: 'call.decline', callId: this.state.callId });
    this.end('declined', false);
  }

  hangup(): void {
    this.end('hangup', true);
  }

  setMicMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.update({ micMuted: muted });
    this.sendMediaState();
  }

  setCameraOff(off: boolean): void {
    this.applyVideoEnabled(!off && !this.backgrounded);
    this.update({ cameraOff: off });
    this.sendMediaState();
  }

  async setSpeaker(on: boolean): Promise<void> {
    this.update({ speakerOn: on });
    await CallSessionNative.setSpeaker(on).catch(() => {});
  }

  async switchCamera(): Promise<void> {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return;
    const front = !this.state.frontCamera;
    try {
      await track.applyConstraints({ facingMode: front ? 'user' : 'environment' });
    } catch {
      track._switchCamera();
    }
    this.update({ frontCamera: front });
  }

  /** The camera pauses while the app is in the background and resumes when it returns (the other side sees "camera off"). */
  setBackgrounded(backgrounded: boolean): void {
    if (this.backgrounded === backgrounded) return;
    this.backgrounded = backgrounded;
    if (this.state.media !== 'video') return;
    this.applyVideoEnabled(!backgrounded && !this.state.cameraOff);
    this.sendMediaState();
  }

  /** A realtime event for this call. */
  handleServerEvent(event: ServerEvent): void {
    if (this.finished) return;
    switch (event.type) {
      case 'call.ringing':
        if (this.state.direction === 'outgoing') this.update({ remoteRinging: true });
        return;
      case 'call.accepted':
        this.enqueueReceive(() => this.onAccepted(event.payload));
        return;
      case 'call.signal':
        this.enqueueReceive(() => this.onSignal(event.payload));
        return;
      case 'call.ended':
        this.end(endReasonFor(event.reason, this.state.direction), false);
        return;
      case 'call.error':
        this.end(event.code === 'already_in_call' ? 'busy' : event.code === 'not_allowed' ? 'unavailable' : 'failed', false);
        return;
      default:
        return;
    }
  }

  private async onAccepted(payload: string): Promise<void> {
    if (this.state.direction !== 'outgoing' || !this.pc) return;
    const signal = await openSignal(this.state.conversationId, this.state.callId, payload);
    if (signal?.kind !== 'answer') {
      // Not sealed by a member of this conversation: never connect to it.
      this.end('failed', true);
      return;
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
    this.remoteDescriptionSet = true;
    await this.addHeldCandidates();
    if (this.state.phase === 'outgoing') this.update({ phase: 'connecting' });
  }

  private async onSignal(payload: string): Promise<void> {
    const signal = await openSignal(this.state.conversationId, this.state.callId, payload);
    if (!signal || this.finished) return;
    const pc = this.pc;
    switch (signal.kind) {
      case 'candidate': {
        const candidate = {
          candidate: signal.candidate,
          sdpMid: signal.sdpMid ?? undefined,
          sdpMLineIndex: signal.sdpMLineIndex ?? undefined,
        };
        if (!pc || !this.remoteDescriptionSet) {
          this.heldCandidates.push(candidate);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        return;
      }
      case 'offer': {
        // An ICE restart from the caller.
        if (!pc || this.state.direction !== 'incoming' || !signal.restart) return;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
        const answer = await pc.createAnswer();
        const sdp = answer.sdp ?? '';
        this.sendSignal({ kind: 'answer', sdp });
        await pc.setLocalDescription(answer);
        return;
      }
      case 'answer':
        // The callee's answer to our ICE restart.
        if (pc && this.state.direction === 'outgoing' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp })).catch(() => {});
        }
        return;
      case 'restart-request':
        if (this.state.direction === 'outgoing') this.restartIce();
        return;
      case 'media-state':
        this.update({ remoteMicMuted: signal.micMuted, remoteCameraOff: signal.cameraOff });
        return;
    }
  }

  private async openMedia(): Promise<void> {
    const video = this.state.media === 'video';
    const permissions = await requestCallPermissions(video);
    if (!permissions.microphone) throw new PermissionDeniedError();
    // A video call still connects with audio when only the camera is refused.
    const stream = await openLocalMedia(video && permissions.camera);
    if (this.finished) {
      releaseStream(stream);
      throw new Error('The call ended while starting.');
    }
    this.localStream = stream;
    this.update({
      cameraOff: video && !permissions.camera,
      localStreamUrl: video && permissions.camera ? stream.toURL() : null,
    });
  }

  private createPeerConnection(iceServers: { urls: string[]; username?: string; credential?: string }[]): RTCPeerConnection {
    // Development only: EXPO_PUBLIC_DEV_FORCE_TURN_RELAY=1 sends media through
    // the TURN relay even when a direct path exists, to verify relay
    // credentials end to end. Always off in release builds.
    const relayOnly = __DEV__ && process.env.EXPO_PUBLIC_DEV_FORCE_TURN_RELAY === '1';
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
    });
    this.pc = pc;
    const stream = this.localStream;
    if (stream) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
    if (this.state.media === 'video' && !stream?.getVideoTracks().length) {
      // Still receive the other side's video when our own camera is unavailable.
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    // react-native-webrtc's published typings lose the EventTarget methods
    // (its vendored event-target-shim types don't resolve), so the few
    // events used here are typed explicitly.
    const events = pc as unknown as PeerConnectionEvents;
    events.addEventListener('icecandidate', (event) => {
      const candidate = event.candidate;
      if (!candidate) return;
      this.sendSignal({
        kind: 'candidate',
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    });
    events.addEventListener('track', (event) => {
      const remote = event.streams[0];
      if (remote) this.update({ remoteStreamUrl: remote.toURL() });
    });
    events.addEventListener('iceconnectionstatechange', () => this.onIceState(pc.iceConnectionState));
    events.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.onIceState('failed');
    });
    return pc;
  }

  private onIceState(iceState: string): void {
    if (this.finished) return;
    switch (iceState) {
      case 'connected':
      case 'completed':
        this.clearReconnectTimers();
        if (this.state.phase !== 'connected') {
          const firstConnect = this.state.connectedAt === null;
          this.update({ phase: 'connected', connectedAt: this.state.connectedAt ?? Date.now() });
          if (firstConnect) {
            void CallSessionNative.startOngoingCall(this.state.callId, this.state.peerName, this.state.media === 'video').catch(() => {});
            this.sendMediaState();
            if (__DEV__) this.startDevStatsLog();
          }
        }
        return;
      case 'disconnected':
        if (this.state.phase === 'connected') this.update({ phase: 'reconnecting' });
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.restartIce();
          }, RECONNECT_AFTER_MS);
        }
        this.armGiveUp();
        return;
      case 'failed':
        if (this.state.phase === 'connected') this.update({ phase: 'reconnecting' });
        this.restartIce();
        this.armGiveUp();
        return;
      default:
        return;
    }
  }

  private restartIce(): void {
    const pc = this.pc;
    if (!pc || this.finished) return;
    if (this.state.direction === 'incoming') {
      this.sendSignal({ kind: 'restart-request' });
      return;
    }
    if (pc.signalingState !== 'stable') return; // a restart is already being negotiated
    void (async () => {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        const sdp = offer.sdp ?? '';
        this.sendSignal({ kind: 'offer', sdp, media: this.state.media, sentAt: Date.now(), restart: true });
        await pc.setLocalDescription(offer);
      } catch {
        // The give-up timer ends the call if nothing recovers.
      }
    })();
  }

  /**
   * Development builds only: logs every few seconds whether media is really
   * flowing (packets, bytes, audio level, decoded frames, and whether the
   * path is direct or relayed). Counters only — no media or keys.
   */
  private startDevStatsLog(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      const pc = this.pc;
      if (!pc) return;
      void pc
        .getStats()
        .then((report: Map<string, Record<string, unknown>>) => {
          const stats = [...report.values()];
          const lines: string[] = [];
          for (const stat of stats) {
            if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp') {
              const inbound = stat.type === 'inbound-rtp';
              let line = `${inbound ? 'in' : 'out'} ${String(stat.kind)} packets=${String(inbound ? stat.packetsReceived : stat.packetsSent)} bytes=${String(inbound ? stat.bytesReceived : stat.bytesSent)}`;
              if (inbound && stat.kind === 'audio') line += ` level=${String(stat.audioLevel)}`;
              if (stat.kind === 'video') line += ` frames=${String(inbound ? stat.framesDecoded : stat.framesEncoded)} ${String(stat.frameWidth)}x${String(stat.frameHeight)}`;
              lines.push(line);
            }
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
              const local = stats.find((candidate) => candidate.id === stat.localCandidateId);
              lines.push(`path=${String(local?.candidateType)} rtt=${String(stat.currentRoundTripTime)}`);
            }
          }
          console.log(`[call ${this.state.callId.slice(0, 8)}] ${lines.join(' | ')}`);
        })
        .catch(() => {});
    }, 5000);
  }

  private armGiveUp(): void {
    if (this.giveUpTimer) return;
    this.giveUpTimer = setTimeout(() => {
      this.giveUpTimer = null;
      if (this.state.phase !== 'connected') this.end('connection_lost', true);
    }, GIVE_UP_AFTER_MS);
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    this.reconnectTimer = null;
    this.giveUpTimer = null;
  }

  private async addHeldCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    for (const candidate of this.heldCandidates.splice(0)) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }
  }

  private applyVideoEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = enabled;
  }

  private sendMediaState(): void {
    if (!this.pc || this.finished) return;
    this.sendSignal({
      kind: 'media-state',
      micMuted: this.state.micMuted,
      cameraOff: this.state.cameraOff || (this.state.media === 'video' && this.backgrounded),
    });
  }

  private sendSignal(signal: CallSignal): void {
    this.enqueueSend(async () => {
      const payload = await sealSignal(this.state.conversationId, this.state.callId, signal);
      if (!this.finished) realtime.send({ type: 'call.signal', callId: this.state.callId, payload });
    });
  }

  private enqueueSend(task: () => Promise<void>): void {
    this.sending = this.sending.then(task).catch(() => {});
  }

  private enqueueReceive(task: () => Promise<void>): void {
    this.receiving = this.receiving.then(task).catch(() => {});
  }

  /** Ends the call and releases everything it held: camera, microphone, peer connection, audio routing, notifications. */
  end(reason: CallEndReason, notifyServer: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (notifyServer) realtime.send({ type: 'call.hangup', callId: this.state.callId });
    this.clearReconnectTimers();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.pc = null;
    releaseStream(this.localStream);
    this.localStream = null;
    this.heldCandidates = [];
    void CallSessionNative.stopRinging().catch(() => {});
    void CallSessionNative.stopAudio().catch(() => {});
    void CallSessionNative.stopOngoingCall().catch(() => {});
    void CallSessionNative.dismissIncomingCall(this.state.callId).catch(() => {});
    this.update({ phase: 'ended', endReason: reason, localStreamUrl: null, remoteStreamUrl: null });
  }

  private update(patch: Partial<CallState>): void {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    if (__DEV__) logTransitions(previous, this.state);
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

const LOGGED_FIELDS = ['phase', 'endReason', 'remoteRinging', 'micMuted', 'cameraOff', 'speakerOn', 'frontCamera', 'remoteMicMuted', 'remoteCameraOff'] as const;

/** Development builds only: the call state changes device tests assert on. Flags and phases only — no media, SDP or keys. */
function logTransitions(previous: CallState, next: CallState): void {
  const changes: string[] = LOGGED_FIELDS.filter((field) => previous[field] !== next[field]).map((field) => `${field}=${String(next[field])}`);
  if (!previous.remoteStreamUrl !== !next.remoteStreamUrl) changes.push(`remoteStream=${next.remoteStreamUrl ? 'on' : 'off'}`);
  if (changes.length > 0) console.log(`[call ${next.callId.slice(0, 8)}] ${next.direction} ${changes.join(' ')}`);
}
