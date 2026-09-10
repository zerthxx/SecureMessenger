import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { stopVoicePlayback } from '@/infrastructure/media/voicePlayer';
import { deleteVoiceFile } from '@/infrastructure/storage/voiceFiles';
import { useVoiceRecorder, type VoiceRecordingResult } from '@/ui/hooks/useVoiceRecorder';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';
import { TextField } from './TextField';
import { VoicePreviewBar } from './VoicePreviewBar';
import { VoiceRecorderBar } from './VoiceRecorderBar';

export interface MessageComposerProps {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onSendVoice: (uri: string, durationMs: number) => void;
}

export function MessageComposer({ disabled, placeholder, onSend, onSendVoice }: MessageComposerProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  // A recording that has been stopped but not yet sent or discarded —
  // its presence is what puts the composer into the "preview" state.
  // Never auto-sent: only `handleSendPreview` (an explicit tap) does that.
  const [preview, setPreview] = useState<VoiceRecordingResult | null>(null);

  const handleMaxDurationReached = useCallback((result: VoiceRecordingResult | null) => {
    if (result) setPreview(result);
  }, []);

  const recorder = useVoiceRecorder(handleMaxDurationReached);

  // Never leave the preview player's native resource open once this
  // composer goes away (navigating out of the conversation, logout).
  useEffect(() => {
    return () => {
      stopVoicePlayback();
    };
  }, []);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !disabled;

  // Audit fix: a rapid double-tap on Send could fire two onPress events
  // before React re-renders with the cleared text — both calls would see
  // the same (still non-empty) `trimmed`/`canSend` from the same render
  // and both call onSend, producing a duplicate sent message. This ref
  // closes that window: it's set the instant the first tap is accepted,
  // and only cleared once a re-render actually reflects the emptied
  // text, mirroring the in-flight-lock pattern already used elsewhere in
  // this codebase (e.g. NewConversationScreen's `startingId`,
  // ChatContext's `startConversationInFlightRef`).
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

  async function handleMicPress() {
    if (disabled) return;
    if (recorder.phase === 'permission_blocked') {
      Linking.openSettings();
      return;
    }
    await recorder.start();
  }

  async function handleStopRecording() {
    const result = await recorder.stop();
    if (result) setPreview(result);
  }

  function handleDeletePreview() {
    if (preview) deleteVoiceFile(preview.uri);
    stopVoicePlayback();
    setPreview(null);
  }

  function handleSendPreview() {
    if (!preview) return;
    stopVoicePlayback();
    onSendVoice(preview.uri, preview.durationMs);
    setPreview(null);
  }

  if (preview) {
    return (
      <VoicePreviewBar uri={preview.uri} durationMs={preview.durationMs} onDelete={handleDeletePreview} onSend={handleSendPreview} />
    );
  }

  if (recorder.phase === 'recording') {
    return <VoiceRecorderBar elapsedMs={recorder.elapsedMs} onCancel={recorder.cancel} onStop={handleStopRecording} />;
  }

  const permissionMessage =
    recorder.phase === 'permission_blocked'
      ? 'Microphone access is blocked. Tap to open Settings and allow it.'
      : recorder.phase === 'permission_denied'
        ? 'Microphone access is needed to record a voice message. Tap the microphone to try again.'
        : null;

  return (
    <View>
      {permissionMessage ? (
        <Pressable
          onPress={recorder.phase === 'permission_blocked' ? () => Linking.openSettings() : undefined}
          style={[styles.permissionBanner, { backgroundColor: theme.colors.surfaceElevated, borderTopColor: theme.colors.border }]}
        >
          <AppText variant="caption" color="secondary">
            {permissionMessage}
          </AppText>
        </Pressable>
      ) : null}
      <View style={[styles.container, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
        <View style={styles.field}>
          <TextField
            value={text}
            onChangeText={setText}
            placeholder={disabled ? 'Waiting for encryption to be ready…' : (placeholder ?? 'Message')}
            editable={!disabled}
            multiline
            returnKeyType="default"
            accessibilityLabel="Message input"
          />
        </View>
        {trimmed.length > 0 ? (
          <IconButton name="send" accessibilityLabel="Send message" onPress={handleSend} variant={canSend ? 'filled' : 'plain'} />
        ) : (
          <IconButton name="mic" accessibilityLabel="Record voice message" onPress={handleMicPress} variant="plain" />
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
  permissionBanner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
