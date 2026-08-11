import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText, Button, Card } from '@/ui/components';
import { useAppUpdate } from './UpdateContext';
import { UpdateSheet } from './UpdateSheet';

/**
 * Home-screen banner — rendered whenever there's a real update pending
 * (see UpdateContext.updatePending) and the dialog isn't already showing
 * the same thing. The close (X) button only hides this banner instance
 * for the current mount — it is deliberately NOT persisted anywhere:
 * the root-level UpdateIndicator remains the durable, always-reachable
 * affordance regardless of what happens here.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const { status, manifest, updatePending } = useAppUpdate();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [locallyHidden, setLocallyHidden] = useState(false);

  if (status !== 'available' || !manifest || !updatePending || locallyHidden) {
    return null;
  }

  return (
    <>
      <Card style={[styles.card, { backgroundColor: theme.colors.primaryMuted }]}>
        <View style={styles.row}>
          <View style={[styles.iconWrap, { backgroundColor: theme.colors.surface }]}>
            <Ionicons name="download-outline" size={20} color={theme.colors.primary} />
          </View>
          <View style={styles.textWrap}>
            <AppText variant="bodyMedium">New update available</AppText>
            <AppText variant="caption" color="secondary">
              SecureMessenger v{manifest.versionName}
            </AppText>
          </View>
          {manifest.mandatory ? null : (
            <Pressable
              onPress={() => setLocallyHidden(true)}
              accessibilityRole="button"
              accessibilityLabel="Hide this update notification"
              hitSlop={8}
            >
              <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>
        <Button label="Download Update" size="md" fullWidth onPress={() => setSheetVisible(true)} />
      </Card>
      <UpdateSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
  },
});
