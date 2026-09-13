import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Vibration, View } from 'react-native';

import { stopVoicePlayback } from '@/infrastructure/media/voicePlayer';
import { useVoiceRecorder, type VoiceRecordingResult } from '@/ui/hooks/useVoiceRecorder';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { HoldToRecordButton, SLIDE_TO_CANCEL_DISTANCE } from './HoldToRecordButton';
import { IconButton } from './IconButton';
import { TextField } from './TextField';
import { VoiceRecorderBar } from './VoiceRecorderBar';

export interface MessageComposerProps {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onSendVoice: (uri: string, durationMs: number) => void;
}

const HINT_DURATION_MS = 2500;

export function MessageComposer({ disabled, placeholder, onSend, onSendVoice }: MessageComposerProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [slideDistance, setSlideDistance] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  // Recording started from a screen reader (no hold gesture) — shows explicit Cancel/Send buttons.
  const [screenReaderRecording, setScreenReaderRecording] = useState(false);
  // True while a finger is holding the record button. A press that ends
  // while the recorder is still starting flips this back before start()
  // resolves, so that recording is discarded instead of running on.
  const holdingRef = useRef(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSendVoiceRef = useRef(onSendVoice);
  onSendVoiceRef.current = onSendVoice;

  const showHint = useCallback((message: string) => {
    setHint(message);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), HINT_DURATION_MS);
  }, []);

  const sendRecording = useCallback(
    (result: VoiceRecordingResult | null) => {
      if (result) {
        stopVoicePlayback();
        onSendVoiceRef.current(result.uri, result.durationMs);
      } else {
        showHint('Hold the microphone a little longer to record.');
      }
    },
    [showHint],
  );

  // Reaching the 2-minute limit sends what was recorded, the same as releasing.
  const handleMaxDurationReached = useCallback(
    (result: VoiceRecordingResult | null) => {
      holdingRef.current = false;
      setScreenReaderRecording(false);
      setSlideDistance(0);
      sendRecording(result);
    },
    [sendRecording],
  );

  const recorder = useVoiceRecorder(handleMaxDurationReached);

  // Never leave a player or timer running once the composer goes away
  // (navigating out of the conversation, logout). The recorder hook itself
  // stops and discards an in-progress recording on unmount.
  useEffect(() => {
    return () => {
      stopVoicePlayback();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !disabled;
  const recording = recorder.phase === 'recording';

  // Audit fix: a rapid double-tap on Send could fire two onPress events
  // before React re-renders with the cleared text — both calls would see
  // the same (still non-empty) `trimmed`/`canSend` from the same render
  // and both call onSend, producing a duplicate sent message. This ref
  // closes that window: it's set the instant the first tap is accepted,
  // and only cleared once a re-render actually reflects the emptied text.
  const sendingRef = useRef(false);
  useEffect(() => {
    sendingRef.current = false;
  }, [text]);

  function handleSend() {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    const value = trimmed;
    setText('');
    onSend(value);
  }

  /** Starts recording if the microphone is available; returns whether recording actually began. */
  async function beginRecording(): Promise<boolean> {
    if (disabled) return false;
    if (recorder.phase === 'permission_blocked') {
      Linking.openSettings();
      return false;
    }
    const result = await recorder.start();
    switch (result) {
      case 'recording':
        Vibration.vibrate(15);
        return true;
      case 'permission_granted':
        showHint('Microphone ready. Press and hold to record.');
        return false;
      case 'failed':
        showHint('Couldn’t start recording. Please try again.');
        return false;
      default:
        return false; // denied/blocked are shown in the permission banner; busy is ignored
    }
  }

  async function handleHoldStart() {
    holdingRef.current = true;
    setSlideDistance(0);
    setHint(null);
    const started = await beginRecording();
    if (started && !holdingRef.current) {
      // The press ended (or was cancelled) while the recorder was starting.
      recorder.cancel();
    }
  }

  async function handleRelease() {
    holdingRef.current = false;
    setSlideDistance(0);
    sendRecording(await recorder.stop());
  }

  function handleCancel() {
    holdingRef.current = false;
    setSlideDistance(0);
    recorder.cancel();
    Vibration.vibrate(30);
    showHint('Voice message cancelled.');
  }

  function handleTap() {
    if (recorder.phase === 'permission_blocked') {
      Linking.openSettings();
      return;
    }
    showHint('Press and hold to record a voice message.');
  }

  async function handleAccessibilityActivate() {
    if (recording) {
      setScreenReaderRecording(false);
      sendRecording(await recorder.stop());
      return;
    }
    if (await beginRecording()) setScreenReaderRecording(true);
  }

  function handleScreenReaderCancel() {
    setScreenReaderRecording(false);
    recorder.cancel();
  }

  async function handleScreenReaderSend() {
    setScreenReaderRecording(false);
    sendRecording(await recorder.stop());
  }

  const permissionMessage =
    recorder.phase === 'permission_blocked'
      ? 'Microphone access is blocked. Tap to open Settings and allow it.'
      : recorder.phase === 'permission_denied'
        ? 'Microphone access is needed to record a voice message. Press and hold the microphone to try again.'
        : null;

  return (
    <View>
      {permissionMessage ? (
        <Pressable
          onPress={recorder.phase === 'permission_blocked' ? () => Linking.openSettings() : undefined}
          style={[styles.banner, { backgroundColor: theme.colors.surfaceElevated, borderTopColor: theme.colors.border }]}
        >
          <AppText variant="caption" color="secondary">
            {permissionMessage}
          </AppText>
        </Pressable>
      ) : hint ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.surfaceElevated, borderTopColor: theme.colors.border }]}>
          <AppText variant="caption" color="secondary" accessibilityLiveRegion="polite">
            {hint}
          </AppText>
        </View>
      ) : null}
      <View style={[styles.container, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
        <View style={styles.field}>
          {recording ? (
            <VoiceRecorderBar
              elapsedMs={recorder.elapsedMs}
              slideDistance={slideDistance}
              cancelDistance={SLIDE_TO_CANCEL_DISTANCE}
              onCancel={screenReaderRecording ? handleScreenReaderCancel : undefined}
              onSend={screenReaderRecording ? handleScreenReaderSend : undefined}
            />
          ) : (
            <TextField
              value={text}
              onChangeText={setText}
              placeholder={disabled ? 'Waiting for encryption to be ready…' : (placeholder ?? 'Message')}
              editable={!disabled}
              multiline
              returnKeyType="default"
              accessibilityLabel="Message input"
            />
          )}
        </View>
        {trimmed.length > 0 && !recording ? (
          <IconButton name="send" accessibilityLabel="Send message" onPress={handleSend} variant={canSend ? 'filled' : 'plain'} />
        ) : (
          <HoldToRecordButton
            disabled={disabled}
            recording={recording}
            onHoldStart={handleHoldStart}
            onRelease={handleRelease}
            onCancel={handleCancel}
            onSlide={setSlideDistance}
            onTap={handleTap}
            onAccessibilityActivate={handleAccessibilityActivate}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  field: {
    flex: 1,
  },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
