import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';

import { formatAutoTerminate, formatDateTime, platformLabel } from '@/core/utils/sessionFormat';
import { getApiErrorMessage } from '@/infrastructure/network/trpcClient';
import { realtime } from '@/infrastructure/realtime/realtimeClient';
import { AppText, ConfirmModal, Divider, ErrorState, ListRow, LoadingState } from '@/ui/components';
import { SectionLabel, SettingsCard, SettingsRow, SettingsScreenFrame } from '@/ui/screens/settings/SettingsSections';
import { useTheme } from '@/ui/theme';
import { AutoTerminateSheet } from './AutoTerminateSheet';
import { DetailRow, SessionRow, applicationLabel } from './SessionRow';
import { clearSessionsNotice, loadSessions, terminateOtherSessions, useSessionsState } from './sessionsStore';

const NOTICE_VISIBLE_MS = 4000;
/** Re-renders relative "last active" labels; this redraws text only and makes no requests. */
const CLOCK_TICK_MS = 60 * 1000;

/**
 * Settings → Privacy & Security → Devices: this device, terminating every
 * other session, automatic termination of unused sessions, and the list of
 * other active sessions. All enforcement happens on the server.
 */
export function DevicesScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { status, sessions, autoTerminateDays, error, notice } = useSessionsState();
  const [confirmAllVisible, setConfirmAllVisible] = useState(false);
  const [autoSheetVisible, setAutoSheetVisible] = useState(false);
  const [terminatingAll, setTerminatingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      void loadSessions();
    }, []),
  );

  // A login on another device while this screen is open shows up right away.
  useEffect(() => {
    const off = realtime.onEvent((event) => {
      if (event.type === 'security.new_login') void loadSessions();
    });
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(clearSessionsNotice, NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const current = sessions.find((session) => session.isCurrent) ?? null;
  const others = sessions.filter((session) => !session.isCurrent);

  async function handleTerminateAll() {
    setConfirmAllVisible(false);
    setActionError(null);
    setTerminatingAll(true);
    try {
      await terminateOtherSessions();
    } catch (err) {
      setActionError(getApiErrorMessage(err, "Couldn't terminate the other sessions. Please try again."));
    } finally {
      setTerminatingAll(false);
    }
  }

  if (sessions.length === 0 && (status === 'idle' || status === 'loading')) {
    return (
      <SettingsScreenFrame title="Devices">
        <LoadingState rows={4} />
      </SettingsScreenFrame>
    );
  }

  if (sessions.length === 0 && status === 'error') {
    return (
      <SettingsScreenFrame title="Devices">
        <ErrorState title="Couldn't load your devices" message={error ?? undefined} onRetry={() => void loadSessions()} />
      </SettingsScreenFrame>
    );
  }

  return (
    <SettingsScreenFrame
      title="Devices"
      overlay={<AutoTerminateSheet visible={autoSheetVisible} currentDays={autoTerminateDays} onClose={() => setAutoSheetVisible(false)} />}
    >
      {notice ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.success + '1A' }]} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={18} color={theme.colors.success} />
          <AppText variant="bodyMedium" style={{ color: theme.colors.success }}>
            {notice}
          </AppText>
        </View>
      ) : null}
      {actionError ? (
        <View style={[styles.banner, { backgroundColor: theme.colors.danger + '1A' }]} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={18} color={theme.colors.danger} />
          <AppText variant="bodyMedium" color="danger" style={styles.flex}>
            {actionError}
          </AppText>
        </View>
      ) : null}

      <SectionLabel text="This device" />
      <SettingsCard>
        {current ? (
          <>
            <View style={styles.rowPadding}>
              <SessionRow session={current} now={now} />
            </View>
            <Divider inset={16} />
            <DetailRow label="Platform" value={platformLabel(current.platform)} />
            <DetailRow label="System" value={current.osVersion ?? 'Unknown'} />
            <DetailRow label="App version" value={current.appVersion ? applicationLabel(current) : 'Unknown'} />
            <DetailRow label="Status" value="Online" valueColor={theme.colors.online} />
            <DetailRow label="Last active" value="Now" />
            <DetailRow label="First login" value={formatDateTime(current.firstLoginAt)} />
            <Divider />
          </>
        ) : null}
        <Pressable
          onPress={() => setConfirmAllVisible(true)}
          disabled={terminatingAll || others.length === 0}
          accessibilityRole="button"
          accessibilityState={{ disabled: terminatingAll || others.length === 0 }}
          style={({ pressed }) => [styles.destructiveRow, pressed ? { opacity: 0.6 } : null, others.length === 0 ? { opacity: 0.45 } : null]}
        >
          <Ionicons name="hand-left-outline" size={20} color={theme.colors.danger} />
          <AppText variant="bodyMedium" color="danger" style={styles.flex}>
            Terminate All Other Sessions
          </AppText>
          {terminatingAll ? <ActivityIndicator size="small" color={theme.colors.danger} /> : null}
        </Pressable>
      </SettingsCard>
      <AppText variant="caption" color="secondary" style={styles.footnote}>
        Logs out all devices except for this one.
      </AppText>

      <SectionLabel text="Automatically terminate old sessions" />
      <SettingsCard>
        <SettingsRow>
          <ListRow
            icon="timer-outline"
            label="If inactive for"
            subtitle={autoTerminateDays !== null ? formatAutoTerminate(autoTerminateDays) : '—'}
            onPress={() => setAutoSheetVisible(true)}
          />
        </SettingsRow>
      </SettingsCard>
      <AppText variant="caption" color="secondary" style={styles.footnote}>
        Devices that haven't been used for this long are signed out automatically.
      </AppText>

      <SectionLabel text={others.length > 0 ? `Active sessions (${others.length})` : 'Active sessions'} />
      <SettingsCard>
        {others.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="phone-portrait-outline" size={28} color={theme.colors.textTertiary} />
            <AppText variant="body" color="secondary" style={styles.centered}>
              No other devices are signed in to your account.
            </AppText>
          </View>
        ) : (
          others.map((session, index) => (
            <View key={session.id}>
              {index > 0 ? <Divider inset={72} /> : null}
              <Pressable
                onPress={() => router.push({ pathname: '/settings/session/[id]', params: { id: session.id } } as unknown as Href)}
                accessibilityRole="button"
                accessibilityHint="Shows session details"
                style={({ pressed }) => [styles.rowPadding, pressed ? { opacity: 0.6 } : null]}
              >
                <SessionRow session={session} now={now} showChevron />
              </Pressable>
            </View>
          ))
        )}
      </SettingsCard>
      {others.length > 0 ? (
        <AppText variant="caption" color="secondary" style={styles.footnote}>
          Tap a session to see its details or terminate it.
        </AppText>
      ) : null}

      <ConfirmModal
        visible={confirmAllVisible}
        title="Terminate all other sessions?"
        message="Every other device signed in to your account will be logged out. This device stays signed in."
        confirmLabel="Terminate"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleTerminateAll}
        onCancel={() => setConfirmAllVisible(false)}
      />
    </SettingsScreenFrame>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 16,
  },
  rowPadding: {
    paddingHorizontal: 16,
  },
  destructiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  footnote: {
    marginTop: 8,
    marginHorizontal: 4,
  },
  empty: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  centered: {
    textAlign: 'center',
  },
  flex: {
    flex: 1,
  },
});
