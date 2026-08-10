import { palette } from './palette';

export type ColorScheme = 'light' | 'dark';

export interface SemanticColors {
  background: string;
  surface: string;
  surfaceElevated: string;
  border: string;
  borderStrong: string;

  primary: string;
  onPrimary: string;
  primaryMuted: string;

  accent: string;
  onAccent: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  onSurfaceInverse: string;

  success: string;
  danger: string;
  warning: string;
  online: string;

  overlay: string;
  skeleton: string;
}

const light: SemanticColors = {
  background: palette.neutral25,
  surface: palette.neutral0,
  surfaceElevated: palette.neutral50,
  border: palette.neutral100,
  borderStrong: palette.neutral200,

  primary: palette.violet600,
  onPrimary: palette.neutral0,
  primaryMuted: palette.violet50,

  accent: palette.coral500,
  onAccent: palette.neutral0,

  textPrimary: palette.neutral900,
  textSecondary: palette.neutral400,
  textTertiary: palette.neutral300,
  onSurfaceInverse: palette.neutral0,

  success: palette.green500,
  danger: palette.red500,
  warning: palette.amber400,
  online: palette.green400,

  overlay: 'rgba(20, 18, 31, 0.5)',
  skeleton: palette.neutral100,
};

const dark: SemanticColors = {
  background: palette.neutral950,
  surface: palette.neutral850,
  surfaceElevated: palette.neutral800,
  border: palette.neutral700,
  borderStrong: palette.neutral600,

  primary: palette.violet400,
  onPrimary: palette.neutral950,
  primaryMuted: palette.violet900,

  accent: palette.coral400,
  onAccent: palette.neutral950,

  textPrimary: palette.neutral0,
  textSecondary: palette.neutral300,
  textTertiary: palette.neutral500,
  onSurfaceInverse: palette.neutral900,

  success: palette.green400,
  danger: palette.red400,
  warning: palette.amber400,
  online: palette.green400,

  overlay: 'rgba(0, 0, 0, 0.65)',
  skeleton: palette.neutral800,
};

export const colorSchemes: Record<ColorScheme, SemanticColors> = { light, dark };
