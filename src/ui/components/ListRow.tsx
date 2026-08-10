import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/ui/theme';
import { AppText } from './AppText';

interface ListRowBaseProps {
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  label: string;
  subtitle?: string;
  destructive?: boolean;
}

interface ListRowNavProps extends ListRowBaseProps {
  type?: 'nav';
  onPress?: () => void;
  value?: undefined;
  onValueChange?: undefined;
}

interface ListRowSwitchProps extends ListRowBaseProps {
  type: 'switch';
  value: boolean;
  onValueChange: (next: boolean) => void;
  onPress?: undefined;
}

export type ListRowProps = ListRowNavProps | ListRowSwitchProps;

export function ListRow(props: ListRowProps): React.JSX.Element {
  const theme = useTheme();
  const { icon, iconColor, label, subtitle, destructive } = props;
  const tint = destructive ? theme.colors.danger : (iconColor ?? theme.colors.primary);

  const content = (
    <View style={styles.row}>
      {icon ? (
        <View style={[styles.iconWrap, { backgroundColor: destructive ? theme.colors.danger + '1A' : theme.colors.primaryMuted }]}>
          <Ionicons name={icon} size={18} color={tint} />
        </View>
      ) : null}
      <View style={styles.textWrap}>
        <AppText variant="bodyLarge" color={destructive ? 'danger' : 'primary'}>
          {label}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color="secondary">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {props.type === 'switch' ? (
        <Switch
          value={props.value}
          onValueChange={props.onValueChange}
          trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
          thumbColor={theme.colors.surface}
        />
      ) : (
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textTertiary} />
      )}
    </View>
  );

  if (props.type === 'switch') {
    return <View style={styles.container}>{content}</View>;
  }

  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.container, pressed ? { opacity: 0.6 } : null]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 56,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
  },
});
