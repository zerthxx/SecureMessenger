import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, usePathname, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';

import CallSessionNative from '../../../../modules/call-session/src';
import type { CallEndReason, CallState } from '@/infrastructure/calls/callSession';
import { useCall } from './CallContext';

// The call screen keeps one dark look regardless of the app theme, like the
// system dialer: video reads better on it and controls stay legible.
const COLORS = {
  background: '#0E1116',
  text: '#FFFFFF',
  secondary: 'rgba(255,255,255,0.72)',
  control: 'rgba(255,255,255,0.14)',
  controlActive: '#FFFFFF',
  danger: '#E5484D',
  accept: '#30A46C',
};

const END_TEXT: Record<CallEndReason, string> = {
  hangup: 'Call ended',
  remote_hangup: 'Call ended',
  declined: 'Call declined',
  busy: 'Busy',
  no_answer: 'No answer',
  missed: 'Missed call',
  answered_elsewhere: 'Answered on another device',
  connection_lost: 'Connection lost',
  permission_denied: 'Microphone access is needed for calls',
  unavailable: 'Can’t call this person right now',
  failed: 'Call failed',
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 60).toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Ticks once a second on its own, so the rest of the screen doesn't re-render with the clock. */
function Duration({ since, style }: { since: number; style: object }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text style={style}>{formatDuration(now - since)}</Text>;
}

function statusText(call: CallState): string | null {
  switch (call.phase) {
    case 'incoming':
      return call.media === 'video' ? 'Incoming video call' : 'Incoming voice call';
    case 'outgoing':
      return call.remoteRinging ? 'Ringing…' : 'Calling…';
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'ended':
      return call.endReason ? END_TEXT[call.endReason] : 'Call ended';
    case 'connected':
      return null;
  }
}

function ControlButton({
  icon,
  label,
  onPress,
  active = false,
  color,
  size = 64,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  active?: boolean;
  color?: string;
  size?: number;
}): React.JSX.Element {
  return (
    <View style={styles.control}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: active }}
        hitSlop={6}
        style={({ pressed }) => [
          styles.controlCircle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? (active ? COLORS.controlActive : COLORS.control) },
          pressed ? { opacity: 0.7 } : null,
        ]}
      >
        <Ionicons name={icon} size={size * 0.42} color={active && !color ? COLORS.background : COLORS.text} />
      </Pressable>
      <Text style={styles.controlLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function CallScreen(): React.JSX.Element {
  const { callId, action } = useLocalSearchParams<{ callId?: string; action?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { call, accept, decline, hangup, toggleMute, toggleCamera, toggleSpeaker, switchCamera, handleCallLink } = useCall();

  // Opened from a call notification: accept, decline, or just show that call.
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!callId) return;
    const key = `${callId}:${action ?? ''}`;
    if (handledLink.current === key) return;
    handledLink.current = key;
    handleCallLink(callId, action);
  }, [callId, action, handleCallLink]);

  // Visible over the lock screen while this screen is up.
  useEffect(() => {
    CallSessionNative.setShowWhenLocked(true);
    return () => CallSessionNative.setShowWhenLocked(false);
  }, []);

  // Leave once there's nothing to show (a linked call gets a moment to arrive).
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (call) return;
    const timer = setTimeout(() => setGaveUp(true), callId ? 8000 : 0);
    return () => clearTimeout(timer);
  }, [call, callId]);
  useEffect(() => {
    if (call || !gaveUp) return;
    if (router.canGoBack()) router.back();
    else router.replace('/(home)' as Href);
  }, [call, gaveUp, router]);

  // A ringing call must be answered or declined; back doesn't dismiss it.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => call?.phase === 'incoming');
    return () => subscription.remove();
  }, [call?.phase]);

  if (!call) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.status}>{callId ? 'Connecting to the call…' : 'Call ended'}</Text>
      </View>
    );
  }

  const video = call.media === 'video';
  const showRemoteVideo = video && !!call.remoteStreamUrl && !call.remoteCameraOff && (call.phase === 'connected' || call.phase === 'reconnecting');
  const showLocalPreview = video && !!call.localStreamUrl && !call.cameraOff && call.phase !== 'ended';
  const status = statusText(call);
  const ended = call.phase === 'ended';

  return (
    <View style={styles.container}>
      {showRemoteVideo ? (
        <RTCView streamURL={call.remoteStreamUrl ?? undefined} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
      ) : null}

      <View style={[styles.header, { paddingTop: insets.top + 32 }, showRemoteVideo ? styles.headerOverVideo : null]}>
        {!showRemoteVideo ? (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{call.peerName.slice(0, 1).toUpperCase()}</Text>
          </View>
        ) : null}
        <Text style={styles.name} numberOfLines={1}>
          {call.peerName}
        </Text>
        {call.phase === 'connected' && call.connectedAt ? (
          <Duration since={call.connectedAt} style={styles.status} />
        ) : (
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {status}
          </Text>
        )}
        {call.phase === 'connected' && call.remoteMicMuted ? <Text style={styles.hint}>{call.peerName} is muted</Text> : null}
        {video && call.phase === 'connected' && call.remoteCameraOff ? <Text style={styles.hint}>Camera off</Text> : null}
        <View style={styles.encrypted}>
          <Ionicons name="lock-closed" size={12} color={COLORS.secondary} />
          <Text style={styles.encryptedText}>End-to-end encrypted</Text>
        </View>
      </View>

      {showLocalPreview ? (
        <View style={[styles.preview, { top: insets.top + 16 }]}>
          <RTCView streamURL={call.localStreamUrl ?? undefined} style={styles.previewVideo} objectFit="cover" mirror={call.frontCamera} zOrder={1} />
        </View>
      ) : null}

      <View style={[styles.controls, { paddingBottom: insets.bottom + 32 }, showRemoteVideo ? styles.controlsOverVideo : null]}>
        {call.phase === 'incoming' ? (
          <View style={styles.row}>
            <ControlButton icon="close" label="Decline" color={COLORS.danger} size={72} onPress={decline} />
            <ControlButton icon={video ? 'videocam' : 'call'} label="Accept" color={COLORS.accept} size={72} onPress={accept} />
          </View>
        ) : ended ? null : (
          <>
            <View style={styles.row}>
              <ControlButton icon={call.micMuted ? 'mic-off' : 'mic'} label={call.micMuted ? 'Unmute' : 'Mute'} active={call.micMuted} onPress={toggleMute} />
              {video ? (
                <ControlButton
                  icon={call.cameraOff ? 'videocam-off' : 'videocam'}
                  label={call.cameraOff ? 'Camera on' : 'Camera off'}
                  active={call.cameraOff}
                  onPress={toggleCamera}
                />
              ) : null}
              {video ? <ControlButton icon="camera-reverse" label="Flip" onPress={switchCamera} /> : null}
              <ControlButton icon={call.speakerOn ? 'volume-high' : 'volume-medium'} label="Speaker" active={call.speakerOn} onPress={toggleSpeaker} />
            </View>
            <View style={styles.row}>
              <ControlButton icon="call" label="End call" color={COLORS.danger} size={72} onPress={hangup} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

/** A "return to call" bar over the rest of the app while a call runs and its screen isn't shown. */
export function ActiveCallBanner(): React.JSX.Element | null {
  const { call } = useCall();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  if (!call || call.phase === 'ended' || call.phase === 'incoming' || pathname === '/call') return null;
  return (
    <Pressable
      onPress={() => router.push('/call' as Href)}
      accessibilityRole="button"
      accessibilityLabel={`Return to call with ${call.peerName}`}
      style={[styles.banner, { paddingTop: insets.top + 6 }]}
    >
      <Ionicons name={call.media === 'video' ? 'videocam' : 'call'} size={14} color={COLORS.text} />
      <Text style={styles.bannerText} numberOfLines={1}>
        {call.phase === 'connected' ? `On call with ${call.peerName} · Tap to return` : `Calling ${call.peerName}…`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 6,
  },
  headerOverVideo: {
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingBottom: 12,
  },
  // Keeps labels and buttons legible over bright video.
  controlsOverVideo: {
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingTop: 24,
  },
  avatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 44,
    fontWeight: '600',
  },
  name: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '600',
  },
  status: {
    color: COLORS.secondary,
    fontSize: 16,
  },
  hint: {
    color: COLORS.secondary,
    fontSize: 13,
  },
  encrypted: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },
  encryptedText: {
    color: COLORS.secondary,
    fontSize: 12,
  },
  preview: {
    position: 'absolute',
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  previewVideo: {
    flex: 1,
  },
  controls: {
    marginTop: 'auto',
    gap: 28,
    paddingHorizontal: 24,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  control: {
    alignItems: 'center',
    gap: 8,
    minWidth: 72,
  },
  controlCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlLabel: {
    color: COLORS.secondary,
    fontSize: 12,
  },
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingBottom: 6,
    backgroundColor: COLORS.accept,
  },
  bannerText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
});
