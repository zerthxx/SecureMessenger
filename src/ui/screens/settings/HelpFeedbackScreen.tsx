import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Divider } from '@/ui/components';
import { SettingsCard, SettingsScreenFrame } from './SettingsSections';

const HELP_TOPICS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'chatbubble-ellipses-outline',
    title: 'Start a chat',
    body: 'Tap New chat on the Home screen and search for the other person by their username.',
  },
  {
    icon: 'mic-outline',
    title: 'Voice messages',
    body: 'In a chat, press and hold the microphone to record. Release to send, or slide left to cancel.',
  },
  {
    icon: 'lock-closed-outline',
    title: 'End-to-end encryption',
    body: 'Messages and voice messages are encrypted on your device before they are sent. The server only stores encrypted data it cannot read.',
  },
  {
    icon: 'phone-portrait-outline',
    title: 'Your messages stay on this device',
    body: 'Messages and encryption keys are stored only on this device. Uninstalling the app or clearing its data deletes them permanently.',
  },
  {
    icon: 'key-outline',
    title: 'Forgot your password?',
    body: 'On the login screen, use Forgot password with your recovery code to set a new password. The recovery code resets your password only; it does not restore messages.',
  },
  {
    icon: 'shield-checkmark-outline',
    title: 'Changing your password',
    body: 'Changing your password signs out every other device signed in to your account.',
  },
  {
    icon: 'cloud-download-outline',
    title: 'Updates',
    body: 'Go to Settings and tap Check for updates to see whether a newer version is available.',
  },
];

/**
 * Help content. The feedback form that used to follow it is hidden: there is
 * no feedback endpoint or support inbox yet, so it could only ever say that
 * nothing written there would be delivered — a dead end.
 */
export function HelpFeedbackScreen(): React.JSX.Element {
  const theme = useTheme();

  return (
    <SettingsScreenFrame title="Help">
      <SettingsCard>
        {HELP_TOPICS.map((topic, index) => (
          <View key={topic.title}>
            {index > 0 ? <Divider inset={56} /> : null}
            <View style={styles.topic}>
              <Ionicons name={topic.icon} size={20} color={theme.colors.primary} style={styles.topicIcon} />
              <View style={styles.topicText}>
                <AppText variant="bodyMedium">{topic.title}</AppText>
                <AppText variant="body" color="secondary">
                  {topic.body}
                </AppText>
              </View>
            </View>
          </View>
        ))}
      </SettingsCard>

    </SettingsScreenFrame>
  );
}

const styles = StyleSheet.create({
  topic: {
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  topicIcon: {
    marginTop: 2,
  },
  topicText: {
    flex: 1,
    gap: 4,
  },
});
