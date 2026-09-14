import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, BrandMark, Button } from '@/ui/components';
import { SessionEndedBanner } from './auth/SessionEndedBanner';

const highlights: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: 'lock-closed-outline', text: 'Your conversations stay yours' },
  { icon: 'flash-outline', text: 'Fast, minimal, distraction-free' },
  { icon: 'eye-off-outline', text: 'No trackers, no ad profiling' },
];

export interface WelcomeScreenProps {
  onCreateAccount: () => void;
  onLogIn: () => void;
}

export function WelcomeScreen({ onCreateAccount, onLogIn }: WelcomeScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background, paddingBottom: insets.bottom + theme.spacing.xl }]}>
      <View style={styles.hero}>
        <SessionEndedBanner />
        <BrandMark size={64} />
        <AppText variant="display" style={styles.title}>
          Talk freely.
        </AppText>
        <AppText variant="bodyLarge" color="secondary" style={styles.subtitle}>
          A private messenger built for speed and calm — nothing you say is anyone else's business.
        </AppText>
      </View>

      <View style={styles.highlights}>
        {highlights.map((item) => (
          <View key={item.text} style={styles.highlightRow}>
            <View style={[styles.highlightIcon, { backgroundColor: theme.colors.primaryMuted }]}>
              <Ionicons name={item.icon} size={16} color={theme.colors.primary} />
            </View>
            <AppText variant="body" color="secondary" style={styles.highlightText}>
              {item.text}
            </AppText>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button label="Create account" size="lg" fullWidth onPress={onCreateAccount} />
        <Button label="Log in" variant="secondary" size="lg" fullWidth onPress={onLogIn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingTop: 64,
  },
  hero: {
    alignItems: 'flex-start',
  },
  title: {
    marginTop: 24,
  },
  subtitle: {
    marginTop: 12,
    maxWidth: 320,
  },
  highlights: {
    gap: 16,
  },
  highlightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  highlightIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  highlightText: {
    flex: 1,
  },
  actions: {
    gap: 12,
  },
});
