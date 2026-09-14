import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker';

import { BIRTHDAY_MIN_DATE, formatIsoBirthday, isoDateToLocalDate, toIsoDate } from '@/core/utils/birthday';
import type { BirthdayVisibility, ProfileUpdate } from '@/domain/entities';
import { pickProfilePhoto, prepareProfilePhoto, type PreparedProfilePhoto } from '@/infrastructure/media/profilePhoto';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { useAvatarImage } from '@/ui/hooks/useAvatarImage';
import { useTheme } from '@/ui/theme';
import { AppText, Avatar, Button, Divider, TextField } from '@/ui/components';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { SectionLabel, SettingsCard, SettingsScreenFrame, useSettingsBack } from './SettingsSections';

const MAX_DISPLAY_NAME_LENGTH = 50;
/** Same limit the server enforces (server/src/lib/profile.ts), counted per character the way it counts them. */
const MAX_BIO_LENGTH = 160;
/** Where the date picker opens when no birthday is set yet. */
const PICKER_DEFAULT_DATE = new Date(2000, 0, 1, 12);

const VISIBILITY_OPTIONS: { value: BirthdayVisibility; label: string; description: string }[] = [
  { value: 'hidden', label: 'Only me', description: 'Nobody else can see your birthday.' },
  { value: 'month_day', label: 'Day & month', description: 'Others see the day and month, never the year.' },
  { value: 'full', label: 'Full date', description: 'Others see your full date of birth.' },
];

/** A photo change waiting for "Save changes": none, a new (already resized) photo, or removal. */
type PhotoChange = { kind: 'none' } | { kind: 'replace'; photo: PreparedProfilePhoto } | { kind: 'remove' };

function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Edits the profile: photo, display name, bio, birthday and who can see it. The username is the account's permanent handle. */
export function EditProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const goBack = useSettingsBack();
  const { user, profile, refreshProfile, updateProfile, uploadAvatar, removeAvatar } = useAuth();

  const savedName = profile?.displayName ?? user?.displayName ?? '';
  const savedBio = profile?.bio ?? '';
  const savedBirthday = profile?.birthday ?? null;
  const savedVisibility: BirthdayVisibility = profile?.birthdayVisibility ?? 'month_day';

  const [displayName, setDisplayName] = useState(savedName);
  const [bio, setBio] = useState(savedBio);
  const [birthday, setBirthday] = useState<string | null>(savedBirthday);
  const [visibility, setVisibility] = useState<BirthdayVisibility>(savedVisibility);
  const [photoChange, setPhotoChange] = useState<PhotoChange>({ kind: 'none' });
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [showInlineDatePicker, setShowInlineDatePicker] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The full profile loads in the background after sign-in. If this screen
  // opened first, fill the form when it arrives — unless editing already began.
  const editedRef = useRef(false);
  const filledRef = useRef(profile !== null);
  useEffect(() => {
    if (!profile || filledRef.current) return;
    filledRef.current = true;
    if (editedRef.current) return;
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? '');
    setBirthday(profile.birthday);
    setVisibility(profile.birthdayVisibility);
  }, [profile]);

  useEffect(() => {
    if (!profile) refreshProfile().catch(() => {});
    // Once on open, and only when the background load hasn't succeeded yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remoteAvatarUri = useAvatarImage(user?.id, profile?.avatarId);
  const previewUri =
    photoChange.kind === 'replace' ? photoChange.photo.uri : photoChange.kind === 'remove' ? null : remoteAvatarUri;
  const hasPhoto = photoChange.kind === 'replace' || (photoChange.kind === 'none' && !!profile?.avatarId);

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const bioLength = characterCount(trimmedBio);
  const bioTooLong = bioLength > MAX_BIO_LENGTH;
  const nameChanged = trimmedName !== savedName;
  const bioChanged = trimmedBio !== savedBio;
  const birthdayChanged = birthday !== savedBirthday;
  const visibilityChanged = visibility !== savedVisibility;
  const fieldsChanged = nameChanged || bioChanged || birthdayChanged || visibilityChanged;
  const changed = fieldsChanged || photoChange.kind !== 'none';
  const busy = saving || preparingPhoto;
  const visibilityOption = VISIBILITY_OPTIONS.find((option) => option.value === visibility);

  function markEdited() {
    editedRef.current = true;
    setSaved(false);
    setError(null);
  }

  async function handleChoosePhoto() {
    if (busy) return;
    setPhotoError(null);
    try {
      const picked = await pickProfilePhoto();
      if (!picked) return;
      setPreparingPhoto(true);
      const photo = await prepareProfilePhoto(picked);
      markEdited();
      setPhotoChange({ kind: 'replace', photo });
    } catch {
      setPhotoError("Couldn't use that photo. Please try a different one.");
    } finally {
      setPreparingPhoto(false);
    }
  }

  function handleRemovePhoto() {
    markEdited();
    setPhotoError(null);
    setPhotoChange(profile?.avatarId ? { kind: 'remove' } : { kind: 'none' });
  }

  function handleBirthdayPicked(event: DateTimePickerEvent, date?: Date) {
    setShowInlineDatePicker(false);
    if (event.type !== 'set' || !date) return;
    markEdited();
    setBirthday(toIsoDate(date));
  }

  function openBirthdayPicker() {
    if (busy) return;
    const value = (birthday ? isoDateToLocalDate(birthday) : null) ?? PICKER_DEFAULT_DATE;
    if (Platform.OS === 'android') {
      // The native Android date dialog — future dates and dates before 1900 can't be picked.
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        minimumDate: BIRTHDAY_MIN_DATE,
        maximumDate: new Date(),
        onChange: handleBirthdayPicked,
      });
    } else {
      setShowInlineDatePicker((visible) => !visible);
    }
  }

  function handleClearBirthday() {
    markEdited();
    setBirthday(null);
    setShowInlineDatePicker(false);
  }

  async function saveFields(): Promise<boolean> {
    if (!fieldsChanged) return true;
    const input: ProfileUpdate = {};
    if (nameChanged) input.displayName = trimmedName;
    if (bioChanged) input.bio = trimmedBio === '' ? null : trimmedBio;
    if (birthdayChanged) input.birthday = birthday;
    if (visibilityChanged) input.birthdayVisibility = visibility;
    try {
      const next = await updateProfile(input);
      // Show what the server stored (it normalizes the bio), so nothing looks unsaved.
      setDisplayName(next.displayName);
      setBio(next.bio ?? '');
      setBirthday(next.birthday);
      setVisibility(next.birthdayVisibility);
      return true;
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not save your profile. Please try again.'));
      return false;
    }
  }

  async function savePhoto(): Promise<boolean> {
    if (photoChange.kind === 'none') return true;
    setPhotoError(null);
    try {
      if (photoChange.kind === 'replace') {
        await uploadAvatar(photoChange.photo);
      } else {
        await removeAvatar();
      }
      setPhotoChange({ kind: 'none' });
      return true;
    } catch (err) {
      const fallback = photoChange.kind === 'replace' ? "Couldn't upload your photo." : "Couldn't remove your photo.";
      setPhotoError(getApiErrorMessage(err, fallback));
      return false;
    }
  }

  async function handleSave() {
    if (trimmedName.length === 0) {
      setNameError('Enter a display name.');
      return;
    }
    if (trimmedName.length > MAX_DISPLAY_NAME_LENGTH) {
      setNameError(`Use ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
      return;
    }
    if (bioTooLong) return;
    setError(null);
    setSaving(true);
    try {
      // Text fields first, then the photo: if only the upload fails, the text
      // is already saved and "Try again" retries just the photo.
      if (!(await saveFields())) return;
      if (!(await savePhoto())) return;
      setSaved(true);
      setTimeout(goBack, 900);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsScreenFrame title="Edit profile">
      <View style={styles.header}>
        <Pressable onPress={handleChoosePhoto} disabled={busy} accessibilityRole="button" accessibilityLabel="Change profile photo">
          <Avatar name={trimmedName || savedName} size="xl" imageUri={previewUri} />
          <View style={[styles.cameraBadge, { backgroundColor: theme.colors.primary, borderColor: theme.colors.background }]}>
            {preparingPhoto ? (
              <ActivityIndicator size="small" color={theme.colors.onPrimary} />
            ) : (
              <Ionicons name="camera" size={16} color={theme.colors.onPrimary} />
            )}
          </View>
        </Pressable>
        <View style={styles.photoActions}>
          <Button label="Change profile photo" variant="secondary" onPress={handleChoosePhoto} disabled={busy} />
          {hasPhoto ? <Button label="Remove photo" variant="ghost" onPress={handleRemovePhoto} disabled={busy} /> : null}
        </View>
        {photoChange.kind === 'replace' ? (
          <AppText variant="caption" color="secondary" style={styles.centered}>
            Preview — tap Save changes to use this photo.
          </AppText>
        ) : photoChange.kind === 'remove' ? (
          <AppText variant="caption" color="secondary" style={styles.centered}>
            Your photo will be removed when you save.
          </AppText>
        ) : null}
        {photoError ? (
          <View style={styles.photoError}>
            <AppText variant="caption" color="danger" style={styles.centered}>
              {photoError}
            </AppText>
            {photoChange.kind !== 'none' ? <Button label="Try again" variant="ghost" onPress={handleSave} disabled={busy} /> : null}
          </View>
        ) : null}
      </View>

      <SectionLabel text="Profile" />
      <SettingsCard>
        <View style={styles.cardContent}>
          <TextField
            label="Display name"
            value={displayName}
            onChangeText={(text) => {
              setDisplayName(text);
              setNameError(null);
              markEdited();
            }}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            autoCapitalize="words"
            editable={!saving}
            helperText="Shown to the people you chat with."
            errorText={nameError ?? undefined}
          />
          <TextField
            label="Username"
            value={user ? `@${user.username}` : ''}
            editable={false}
            helperText="Your username can't be changed."
          />
          <TextField
            label="Bio"
            value={bio}
            onChangeText={(text) => {
              setBio(text);
              markEdited();
            }}
            placeholder="A few words about yourself"
            multiline
            textAlignVertical="top"
            // A hard stop well above the limit; emoji take two UTF-16 units but count as one character.
            maxLength={MAX_BIO_LENGTH * 2}
            editable={!saving}
            helperText={`${bioLength}/${MAX_BIO_LENGTH}`}
            errorText={bioTooLong ? `Use ${MAX_BIO_LENGTH} characters or fewer (${bioLength}/${MAX_BIO_LENGTH}).` : undefined}
          />
        </View>
      </SettingsCard>

      <SectionLabel text="Birthday" />
      <SettingsCard>
        <Pressable
          onPress={openBirthdayPicker}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={birthday ? `Birthday, ${formatIsoBirthday(birthday)}. Tap to change.` : 'Add your birthday'}
          style={({ pressed }) => [styles.birthdayRow, pressed ? { opacity: 0.6 } : null]}
        >
          <View style={[styles.iconWrap, { backgroundColor: theme.colors.primaryMuted }]}>
            <Ionicons name="gift-outline" size={18} color={theme.colors.primary} />
          </View>
          <View style={styles.flex}>
            <AppText variant="bodyLarge">{birthday ? formatIsoBirthday(birthday) : 'Add your birthday'}</AppText>
            <AppText variant="caption" color="secondary">
              {birthday ? 'Tap to change' : 'Optional'}
            </AppText>
          </View>
          {birthday ? (
            <Pressable onPress={handleClearBirthday} disabled={busy} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove birthday">
              <AppText variant="bodyMedium" color="danger">
                Remove
              </AppText>
            </Pressable>
          ) : (
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textTertiary} />
          )}
        </Pressable>
        {showInlineDatePicker ? (
          <DateTimePicker
            value={(birthday ? isoDateToLocalDate(birthday) : null) ?? PICKER_DEFAULT_DATE}
            mode="date"
            display="inline"
            minimumDate={BIRTHDAY_MIN_DATE}
            maximumDate={new Date()}
            onChange={handleBirthdayPicked}
          />
        ) : null}
        {birthday ? (
          <>
            <Divider inset={16} />
            <View style={styles.cardContent}>
              <AppText variant="label" color="secondary">
                Who can see your birthday
              </AppText>
              <View style={[styles.segmented, { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.md }]}>
                {VISIBILITY_OPTIONS.map((option) => {
                  const active = option.value === visibility;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        markEdited();
                        setVisibility(option.value);
                      }}
                      disabled={saving}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.segment,
                        { backgroundColor: active ? theme.colors.surface : 'transparent', borderRadius: theme.radius.sm },
                        active ? theme.elevation[1] : null,
                      ]}
                    >
                      <AppText variant="bodyMedium" color={active ? 'primary' : 'secondary'} numberOfLines={1}>
                        {option.label}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
              {visibilityOption ? (
                <AppText variant="caption" color="secondary">
                  {visibilityOption.description}
                </AppText>
              ) : null}
            </View>
          </>
        ) : null}
      </SettingsCard>

      {error ? (
        <AppText variant="bodyMedium" style={[styles.feedback, { color: theme.colors.danger }]}>
          {error}
        </AppText>
      ) : null}
      {saved ? (
        <AppText variant="bodyMedium" style={[styles.feedback, { color: theme.colors.success }]}>
          Profile saved
        </AppText>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Save changes"
          size="lg"
          fullWidth
          loading={saving}
          disabled={!changed || saved || bioTooLong || preparingPhoto}
          onPress={handleSave}
        />
        <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={saving} onPress={goBack} />
      </View>
    </SettingsScreenFrame>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    marginTop: 20,
    gap: 10,
  },
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  photoError: {
    alignItems: 'center',
    gap: 4,
  },
  centered: {
    textAlign: 'center',
  },
  cardContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 16,
  },
  birthdayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: {
    flex: 1,
  },
  segmented: {
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
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
