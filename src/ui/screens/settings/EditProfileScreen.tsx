import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useTheme } from '@/ui/theme';
import { AppText, Avatar, Button, TextField } from '@/ui/components';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { SectionLabel, SettingsCard, SettingsScreenFrame, useSettingsBack } from './SettingsSections';

const MAX_DISPLAY_NAME_LENGTH = 50;

/** Edits the profile fields the backend supports: the display name (the username is the account's permanent handle). */
export function EditProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const goBack = useSettingsBack();
  const { user, updateProfile } = useAuth();
  const savedName = user?.displayName ?? '';
  const [displayName, setDisplayName] = useState(savedName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const trimmed = displayName.trim();
  const changed = trimmed !== savedName;

  async function handleSave() {
    if (trimmed.length === 0) {
      setError('Enter a display name.');
      return;
    }
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
      setError(`Use ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await updateProfile({ displayName: trimmed });
      setSaved(true);
      setTimeout(goBack, 900);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not save your profile. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsScreenFrame title="Edit profile">
      <View style={styles.header}>
        <Avatar name={trimmed || savedName} size="xl" />
      </View>

      <SectionLabel text="Profile" />
      <SettingsCard>
        <View style={styles.cardContent}>
          <TextField
            label="Display name"
            value={displayName}
            onChangeText={(text) => {
              setDisplayName(text);
              setError(null);
              setSaved(false);
            }}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            autoCapitalize="words"
            editable={!saving}
            helperText="Shown to the people you chat with."
            errorText={error ?? undefined}
          />
          <TextField
            label="Username"
            value={user ? `@${user.username}` : ''}
            editable={false}
            helperText="Your username can't be changed."
          />
        </View>
      </SettingsCard>

      {saved ? (
        <AppText variant="bodyMedium" style={[styles.feedback, { color: theme.colors.success }]}>
          Profile saved
        </AppText>
      ) : null}

      <View style={styles.actions}>
        <Button label="Save changes" size="lg" fullWidth loading={saving} disabled={!changed || saved} onPress={handleSave} />
        <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={saving} onPress={goBack} />
      </View>
    </SettingsScreenFrame>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    marginTop: 20,
  },
  cardContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 16,
  },
  feedback: {
    marginTop: 16,
    textAlign: 'center',
  },
  actions: {
    marginTop: 20,
    gap: 12,
  },
});
