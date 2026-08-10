import { Platform } from 'react-native';

export type DevicePlatform = 'ios' | 'android' | 'web';

/**
 * No `expo-device` dependency for this — the server only needs a
 * coarse platform enum and a human-readable label, not real hardware
 * identifiers. Naming/managing individual devices is a later feature.
 */
export function getDeviceInfo(): { name: string; platform: DevicePlatform } {
  if (Platform.OS === 'ios') return { name: 'iPhone', platform: 'ios' };
  if (Platform.OS === 'web') return { name: 'Web browser', platform: 'web' };
  return { name: 'Android device', platform: 'android' };
}
