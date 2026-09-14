import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatLastActive, platformLabel } from '@/core/utils/sessionFormat';
import type { DeviceSession } from '@/domain/entities';
import { AppText } from '@/ui/components';
import { useTheme } from '@/ui/theme';

function deviceIconName(platform: string): keyof typeof Ionicons.glyphMap {
  return platform === 'web' ? 'globe-outline' : 'phone-portrait-outline';
}

/** "SecureMessenger 0.9.0" — or just the app name for sessions that predate version reporting. */
export function applicationLabel(session: DeviceSession): string {
  return session.appVersion ? `SecureMessenger ${session.appVersion}` : 'SecureMessenger';
}

/** The device glyph in a tinted circle, with a green dot while the session is online. */
export function DeviceIcon({ session, size = 44 }: { session: DeviceSession; size?: number }): React.JSX.Element {
  const theme = useTheme();
  const dot = Math.round(size * 0.28);
  return (
    <View style={{ width: size, height: size }}>
      <View style={[styles.iconCircle, { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.primaryMuted }]}>
        <Ionicons name={deviceIconName(session.platform)} size={Math.round(size * 0.48)} color={theme.colors.primary} />
      </View>
      {session.online ? (
        <View
          accessibilityElementsHidden
          style={[
            styles.onlineDot,
            { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: theme.colors.online, borderColor: theme.colors.surface },
          ]}
        />
      ) : null}
    </View>
  );
}

export function ThisDeviceTag(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.tag, { backgroundColor: theme.colors.primaryMuted }]}>
      <AppText variant="caption" style={{ color: theme.colors.primary }}>
        This device
      </AppText>
    </View>
  );
}

/** One session in the Devices list: device, app and system, where it was last active, and online / last-active status. */
export function SessionRow({ session, now, showChevron = false }: { session: DeviceSession; now: number; showChevron?: boolean }): React.JSX.Element {
  const theme = useTheme();
  const system = session.osVersion ?? platformLabel(session.platform);
  const status = session.online ? 'online' : formatLastActive(session.lastActiveAt, now);

  return (
    <View style={styles.row} accessible accessibilityLabel={`${session.deviceName}, ${applicationLabel(session)}, ${system}, ${status}`}>
      <DeviceIcon session={session} />
      <View style={styles.text}>
        <View style={styles.titleLine}>
          <AppText variant="bodyMedium" numberOfLines={1} style={styles.flex}>
            {session.deviceName}
          </AppText>
          {session.isCurrent ? (
            <ThisDeviceTag />
          ) : (
            <AppText variant="caption" style={{ color: session.online ? theme.colors.online : theme.colors.textSecondary }}>
              {status}
            </AppText>
          )}
        </View>
        <AppText variant="caption" color="secondary" numberOfLines={1}>
          {applicationLabel(session)} · {system}
        </AppText>
        {session.location ? (
          <AppText variant="caption" color="tertiary" numberOfLines={1}>
            {session.location}
          </AppText>
        ) : null}
      </View>
      {showChevron ? <Ionicons name="chevron-forward" size={18} color={theme.colors.textTertiary} /> : null}
    </View>
  );
}

/** A label/value line inside a settings card, for session details. */
export function DetailRow({
  label,
  value,
  hint,
  valueColor,
}: {
  label: string;
  value: string;
  hint?: string;
  valueColor?: string;
}): React.JSX.Element {
  return (
    <View style={styles.detailRow}>
      <AppText variant="body" color="secondary" style={styles.detailLabel}>
        {label}
      </AppText>
      <View style={styles.detailValueWrap}>
        <AppText variant="bodyMedium" style={[styles.detailValue, valueColor ? { color: valueColor } : null]} selectable>
          {value}
        </AppText>
        {hint ? (
          <AppText variant="caption" color="tertiary" style={styles.detailValue}>
            {hint}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  iconCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  onlineDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    borderWidth: 2,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  flex: {
    flex: 1,
  },
  tag: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  detailLabel: {
    width: 110,
  },
  detailValueWrap: {
    flex: 1,
    alignItems: 'flex-end',
  },
  detailValue: {
    textAlign: 'right',
  },
});
