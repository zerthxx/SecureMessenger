import { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { formatBirthday } from '@/core/utils/birthday';
import { useTheme } from '@/ui/theme';
import { AppText, Card, EmptyState, ErrorState, LoadingState, TopBar } from '@/ui/components';
import { useAuth } from '@/ui/screens/auth/AuthContext';
import { UserAvatar } from './UserAvatar';
import { useUserProfile } from './useUserProfile';

/** Opening this screen refreshes a cached profile older than this, so a changed bio or photo shows up without polling. */
const SCREEN_MAX_AGE_MS = 30 * 1000;

/**
 * Another user's public profile — read-only by design: photo, name, username,
 * bio and whatever part of their birthday they share. Your own profile is
 * edited in Settings → Edit profile, so this screen redirects there.
 */
export function UserProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { user } = useAuth();
  const userId = typeof id === 'string' && id.length > 0 ? id : null;
  const isOwnProfile = !!userId && userId === user?.id;

  useEffect(() => {
    if (isOwnProfile) router.replace('/settings/edit-profile');
  }, [isOwnProfile, router]);

  const { profile, status, reload } = useUserProfile(isOwnProfile ? null : userId, { maxAgeMs: SCREEN_MAX_AGE_MS });

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/chats' as unknown as Href);
    }
  }

  let body: React.ReactNode = null;
  if (isOwnProfile) {
    body = null;
  } else if (profile) {
    body = (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.identity}>
          <UserAvatar userId={profile.id} avatarId={profile.avatarId} name={profile.displayName} size="xl" />
          <AppText variant="headline" style={styles.name} numberOfLines={2}>
            {profile.displayName}
          </AppText>
          <AppText variant="body" color="secondary">
            @{profile.username}
          </AppText>
        </View>

        <Card style={styles.card}>
          <AppText variant="label" color="secondary">
            Bio
          </AppText>
          {profile.bio ? (
            <AppText variant="bodyLarge" style={styles.value} selectable>
              {profile.bio}
            </AppText>
          ) : (
            <AppText variant="body" color="tertiary" style={styles.value}>
              No bio yet.
            </AppText>
          )}
        </Card>

        {profile.birthday ? (
          <Card style={styles.card}>
            <View style={styles.row}>
              <Ionicons name="gift-outline" size={20} color={theme.colors.primary} />
              <View style={styles.rowText}>
                <AppText variant="label" color="secondary">
                  Birthday
                </AppText>
                <AppText variant="bodyLarge" style={styles.value}>
                  {formatBirthday(profile.birthday)}
                </AppText>
              </View>
            </View>
          </Card>
        ) : null}
      </ScrollView>
    );
  } else if (!userId || status === 'not_found') {
    body = (
      <EmptyState icon="person-outline" title="Profile not available" message="This account doesn't exist or is no longer available." />
    );
  } else if (status === 'error') {
    body = <ErrorState title="Couldn't load this profile" message="Check your connection and try again." onRetry={reload} />;
  } else {
    body = <LoadingState rows={3} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title="Profile" onBack={goBack} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
    gap: 16,
  },
  identity: {
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    marginTop: 14,
    textAlign: 'center',
  },
  card: {
    gap: 4,
  },
  value: {
    marginTop: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowText: {
    flex: 1,
  },
});
