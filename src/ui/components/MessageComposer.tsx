import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/ui/theme';
import { IconButton } from './IconButton';
import { TextField } from './TextField';

export interface MessageComposerProps {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
}

export function MessageComposer({ disabled, placeholder, onSend }: MessageComposerProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !disabled;

  function handleSend() {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  }

  return (
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
      <IconButton
        name="send"
        accessibilityLabel="Send message"
        onPress={handleSend}
        variant={canSend ? 'filled' : 'plain'}
      />
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
});
