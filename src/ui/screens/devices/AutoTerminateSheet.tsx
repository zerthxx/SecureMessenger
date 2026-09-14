import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AUTO_TERMINATE_MAX_DAYS, AUTO_TERMINATE_MIN_DAYS, AUTO_TERMINATE_PRESETS, parseCustomDays } from '@/core/utils/sessionFormat';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { AppText, Button, Sheet, TextField } from '@/ui/components';
import { useTheme } from '@/ui/theme';
import { setAutoTerminateDays } from './sessionsStore';

function OptionRow({
  label,
  selected,
  loading,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [styles.option, pressed ? { opacity: 0.6 } : null]}
    >
      <AppText variant="bodyLarge" style={styles.flex}>
        {label}
      </AppText>
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.primary} />
      ) : (
        <Ionicons
          name={selected ? 'radio-button-on' : 'radio-button-off'}
          size={22}
          color={selected ? theme.colors.primary : theme.colors.textTertiary}
        />
      )}
    </Pressable>
  );
}

/** Picks how long a device may stay unused before the server signs it out. */
export function AutoTerminateSheet({
  visible,
  currentDays,
  onClose,
}: {
  visible: boolean;
  currentDays: number | null;
  onClose: () => void;
}): React.JSX.Element {
  const isPreset = AUTO_TERMINATE_PRESETS.some((preset) => preset.days === currentDays);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savingDays, setSavingDays] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    const custom = currentDays !== null && !isPreset;
    setCustomMode(custom);
    setCustomText(custom ? String(currentDays) : '');
    setError(null);
  }, [visible, currentDays, isPreset]);

  async function save(days: number) {
    setSavingDays(days);
    setError(null);
    try {
      await setAutoTerminateDays(days);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, "Couldn't save this setting. Please try again."));
    } finally {
      setSavingDays(null);
    }
  }

  function saveCustom() {
    const parsed = parseCustomDays(customText);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    void save(parsed.days);
  }

  const saving = savingDays !== null;

  return (
    <Sheet visible={visible} onClose={saving ? () => {} : onClose}>
      <View style={styles.content}>
        <AppText variant="title">Automatically terminate old sessions</AppText>
        <AppText variant="body" color="secondary">
          If a device isn't used for this long, it is signed out automatically. The device you're using now is never affected.
        </AppText>

        <View style={styles.options}>
          {AUTO_TERMINATE_PRESETS.map((preset) => (
            <OptionRow
              key={preset.days}
              label={preset.label}
              selected={!customMode && currentDays === preset.days}
              loading={savingDays === preset.days}
              disabled={saving}
              onPress={() => {
                setCustomMode(false);
                void save(preset.days);
              }}
            />
          ))}
          <OptionRow label="Custom" selected={customMode} disabled={saving} onPress={() => setCustomMode(true)} />
        </View>

        {customMode ? (
          <View style={styles.custom}>
            <TextField
              label="Days of inactivity"
              value={customText}
              onChangeText={(text) => {
                setCustomText(text.replace(/[^0-9]/g, ''));
                setError(null);
              }}
              keyboardType="number-pad"
              maxLength={3}
              placeholder="e.g. 45"
              editable={!saving}
              helperText={`Between ${AUTO_TERMINATE_MIN_DAYS} and ${AUTO_TERMINATE_MAX_DAYS} days.`}
              errorText={error ?? undefined}
            />
            <Button label="Save" fullWidth loading={saving} onPress={saveCustom} />
          </View>
        ) : error ? (
          <AppText variant="caption" color="danger">
            {error}
          </AppText>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 12,
    paddingBottom: 8,
  },
  options: {
    marginTop: 4,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  flex: {
    flex: 1,
  },
  custom: {
    gap: 12,
  },
});
