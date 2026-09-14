import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText, IconButton } from '@/ui/components';
import { useTheme } from '@/ui/theme';
import { useAuth } from './AuthContext';

/**
 * Explains a sign-out the user didn't ask for: the server ended this
 * session. Shown until dismissed or until the next sign-in (AuthContext
 * clears `signedOutReason` then).
 */
export function SessionEndedBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const { signedOutReason, acknowledgeSignedOut } = useAuth();
  if (signedOutReason !== 'session_ended') return null;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.banner, { backgroundColor: theme.colors.warning + '1F', borderColor: theme.colors.warning }]}
    >
      <Ionicons name="log-out-outline" size={20} color={theme.colors.textPrimary} style={styles.icon} />
      <View style={styles.text}>
        <AppText variant="bodyMedium">You were signed out</AppText>
        <AppText variant="caption" color="secondary">
          This session was ended — from Devices on another device, by signing out everywhere, or after a long time without
          use. Log in again to continue.
        </AppText>
      </View>
      <IconButton name="close" size={18} accessibilityLabel="Dismiss" onPress={acknowledgeSignedOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 10,
    marginBottom: 24,
  },
  icon: {
    marginTop: 2,
  },
  text: {
    flex: 1,
    gap: 2,
  },
});
