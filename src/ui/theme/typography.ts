import { Platform } from 'react-native';

/**
 * System fonts only (Roboto on Android, San Francisco on iOS) — hierarchy
 * carries the "premium" feel instead of a custom downloaded typeface, to
 * keep the dependency surface small.
 */
const fontFamily = Platform.select({
  android: 'sans-serif',
  default: 'System',
});

const fontFamilyMedium = Platform.select({
  android: 'sans-serif-medium',
  default: 'System',
});

export const typography = {
  display: { fontFamily: fontFamilyMedium, fontSize: 32, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.5 },
  headline: { fontFamily: fontFamilyMedium, fontSize: 24, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.3 },
  title: { fontFamily: fontFamilyMedium, fontSize: 18, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.1 },
  bodyLarge: { fontFamily, fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  body: { fontFamily, fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  bodyMedium: { fontFamily: fontFamilyMedium, fontSize: 14, lineHeight: 20, fontWeight: '600' as const },
  label: { fontFamily: fontFamilyMedium, fontSize: 13, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },
  caption: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: '400' as const, letterSpacing: 0.1 },
} as const;

export type TypographyVariant = keyof typeof typography;
