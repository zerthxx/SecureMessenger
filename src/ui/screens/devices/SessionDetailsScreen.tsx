import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';

import { formatDateTime, formatLastActive, platformLabel } from '@/core/utils/sessionFormat';
import type { DeviceSession } from '@/domain/entities';
import { getApiErrorCode, getApiErrorMessage, sessionsApi } from '@/infrastructure/network/trpcClient';
import { AppText, Button, ConfirmModal, EmptyState, ErrorState, LoadingState, TopBar } from '@/ui/components';
import { SettingsCard } from '@/ui/screens/settings/SettingsSections';
import { useTheme } from '@/ui/theme';
import { DetailRow, DeviceIcon, ThisDeviceTag, applicationLabel } from './SessionRow';
import { terminateSession, useSessionsState } from './sessionsStore';

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';

/** Details of one session — application, device, system, location, network, first login, last activity — and "Terminate Session". */
export function SessionDetailsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const sessionId = typeof id === 'string' ? id : '';
  const { sessions } = useSessionsState();
  const listed = sessions.find((session) => session.id === sessionId) ?? null;

  const [fetched, setFetched] = useState<DeviceSession | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(listed ? 'ready' : 'loading');
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/settings/devices' as unknown as Href);
    }
  }, [router]);

  // Always re-read: the list may be a few minutes old, and last activity matters here.
  const load = useCallback(async () => {
    if (!sessionId) {
      setLoadState('not_found');
      return;
    }
    try {
      const { session } = await sessionsApi.get({ sessionId });
      setFetched(session);
      setLoadState('ready');
    } catch (err) {
      const code = getApiErrorCode(err);
      setLoadState(code === 'NOT_FOUND' || code === 'BAD_REQUEST' ? 'not_found' : 'error');
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const session = fetched ?? listed;

  async function handleTerminate() {
    setConfirmVisible(false);
    setError(null);
    setTerminating(true);
    try {
      await terminateSession(sessionId);
      goBack();
    } catch (err) {
      setError(getApiErrorMessage(err, "Couldn't terminate this session. Please try again."));
      setTerminating(false);
    }
  }

  let body: React.ReactNode;
  if (session && loadState !== 'not_found') {
    body = (
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <DeviceIcon session={session} size={72} />
          <AppText variant="headline" style={styles.centered} numberOfLines={2}>
            {session.deviceName}
          </AppText>
          <AppText variant="body" style={{ color: session.online ? theme.colors.online : theme.colors.textSecondary }}>
            {session.online ? 'online' : `last active ${formatLastActive(session.lastActiveAt)}`}
          </AppText>
          {session.isCurrent ? <ThisDeviceTag /> : null}
        </View>

        <SettingsCard>
          <DetailRow label="Application" value={`${applicationLabel(session)} (${platformLabel(session.platform)})`} />
          <DetailRow label="Device" value={session.model ?? session.deviceName} />
          <DetailRow label="System" value={session.osVersion ?? 'Unknown'} />
          <DetailRow
            label="Location"
            value={session.location ?? 'Unavailable'}
            valueColor={session.location ? undefined : theme.colors.textTertiary}
          />
          <DetailRow
            label="IP address"
            value={session.ipAddress ?? 'Unavailable'}
            valueColor={session.ipAddress ? undefined : theme.colors.textTertiary}
            hint={session.ipAddress ? 'Partially hidden for privacy' : undefined}
          />
          <DetailRow label="First login" value={formatDateTime(session.firstLoginAt)} />
          <DetailRow label="Last activity" value={session.online ? 'Online now' : formatDateTime(session.lastActiveAt)} />
        </SettingsCard>

        {session.isCurrent ? (
          <AppText variant="caption" color="secondary" style={styles.centered}>
            This is the device you're using now. To end this session, sign out.
          </AppText>
        ) : (
          <View style={styles.actions}>
            <Button
              label="Terminate Session"
              variant="danger"
              size="lg"
              fullWidth
              loading={terminating}
              onPress={() => setConfirmVisible(true)}
            />
            {error ? (
              <AppText variant="bodyMedium" color="danger" style={styles.centered}>
                {error}
              </AppText>
            ) : null}
            <AppText variant="caption" color="secondary" style={styles.centered}>
              That device is signed out immediately and has to log in again to use your account.
            </AppText>
          </View>
        )}
      </ScrollView>
    );
  } else if (loadState === 'not_found') {
    body = (
      <EmptyState
        icon="phone-portrait-outline"
        title="Session not found"
        message="This session has ended or isn't one of yours."
        actionLabel="Back to devices"
        onAction={goBack}
      />
    );
  } else if (loadState === 'error') {
    body = (
      <ErrorState
        title="Couldn't load this session"
        message="Check your connection and try again."
        onRetry={() => {
          setLoadState('loading');
          void load();
        }}
      />
    );
  } else {
    body = <LoadingState rows={4} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <TopBar title="Session" onBack={goBack} />
      {body}
      <ConfirmModal
        visible={confirmVisible}
        title="Terminate session"
        message="Are you sure you want to terminate this session?"
        confirmLabel="Terminate"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleTerminate}
        onCancel={() => setConfirmVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 40,
    gap: 16,
  },
  header: {
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  centered: {
    textAlign: 'center',
  },
  actions: {
    gap: 10,
  },
});
