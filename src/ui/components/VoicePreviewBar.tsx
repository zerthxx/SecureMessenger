import { StyleSheet, View } from 'react-native';

import { pauseVoiceMessage, playVoiceMessage } from '@/infrastructure/media/voicePlayer';
import { useVoicePlaybackState } from '@/ui/hooks/useVoicePlayback';
import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';
import { formatClockDuration } from './VoiceRecorderBar';
import { IconButton } from './IconButton';

/** Stable id for the composer's own not-yet-sent recording, distinct from any real message id, so previewing it never collides with (and always interrupts) any message bubble's playback — "only one active playback at a time" applies here too. */
const PREVIEW_PLAYER_ID = 'composer-voice-preview';

export interface VoicePreviewBarProps {
  uri: string;
  durationMs: number;
  onDelete: () => void;
  onSend: () => void;
}

/** Shown after a recording is stopped — lets the user listen back before deciding to send or discard. */
export function VoicePreviewBar({ uri, durationMs, onDelete, onSend }: VoicePreviewBarProps): React.JSX.Element {
  const theme = useTheme();
  const playback = useVoicePlaybackState(PREVIEW_PLAYER_ID);

  function togglePlayback() {
    if (playback.playing) {
      pauseVoiceMessage(PREVIEW_PLAYER_ID);
    } else {
      playVoiceMessage(PREVIEW_PLAYER_ID, uri);
    }
  }

  const remainingMs = playback.duration > 0 ? Math.max(0, durationMs - playback.currentTime * 1000) : durationMs;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
      <IconButton name="trash-outline" accessibilityLabel="Delete voice message" onPress={onDelete} />
      <View style={[styles.previewPill, { backgroundColor: theme.colors.surfaceElevated }]}>
        <IconButton
          name={playback.playing ? 'pause' : 'play'}
          accessibilityLabel={playback.playing ? 'Pause voice message' : 'Play voice message'}
          onPress={togglePlayback}
          size={18}
        />
        <AppText variant="caption" color="secondary">
          {formatClockDuration(remainingMs)}
        </AppText>
      </View>
      <IconButton name="send" accessibilityLabel="Send voice message" onPress={onSend} variant="filled" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  previewPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 20,
    paddingLeft: 4,
    paddingRight: 12,
    paddingVertical: 4,
  },
});
