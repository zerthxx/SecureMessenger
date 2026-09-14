import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type DevicePlatform = 'ios' | 'android' | 'web';

/** What the server records to label this session in Settings → Devices. */
export interface DeviceMetadata {
  model?: string;
  osVersion?: string;
  appVersion?: string;
}

export interface DeviceInfo extends DeviceMetadata {
  name: string;
  platform: DevicePlatform;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * A human-readable description of this device for Settings → Devices
 * ("Samsung SM-S918B", "Android 15", "0.9.0"). Still no `expo-device`
 * dependency and no hardware identifiers: the model name, OS release and
 * app version come from what React Native and the app config already
 * expose, and nothing here is used to authenticate.
 */
export function getDeviceInfo(): DeviceInfo {
  const appVersion = Constants.expoConfig?.version ?? undefined;
  if (Platform.OS === 'android') {
    const { Brand, Model, Release } = Platform.constants;
    const brand = titleCase(Brand ?? '');
    const model = Model
      ? Model.toLowerCase().startsWith(brand.toLowerCase())
        ? Model
        : `${brand} ${Model}`.trim()
      : undefined;
    return {
      name: model ?? 'Android device',
      platform: 'android',
      model,
      osVersion: Release ? `Android ${Release}` : undefined,
      appVersion,
    };
  }
  if (Platform.OS === 'ios') {
    return { name: 'iPhone', platform: 'ios', model: 'iPhone', osVersion: `iOS ${String(Platform.Version)}`, appVersion };
  }
  return { name: 'Web browser', platform: 'web', appVersion };
}

/** The descriptive part only — sent with token refreshes so a session's app/OS version stays current after updates. */
export function getDeviceMetadata(): DeviceMetadata {
  const { model, osVersion, appVersion } = getDeviceInfo();
  return { model, osVersion, appVersion };
}
