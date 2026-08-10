import { Platform } from 'react-native';
import type { ColorScheme } from './colors';

interface ShadowStyle {
  elevation: number;
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
}

const shadowColorFor = (scheme: ColorScheme): string => (scheme === 'dark' ? '#000000' : '#231E5C');

function makeLevels(scheme: ColorScheme): Record<0 | 1 | 2 | 3 | 4, ShadowStyle> {
  const shadowColor = shadowColorFor(scheme);
  const opacityScale = scheme === 'dark' ? 1.4 : 1;
  const level = (elevation: number, opacity: number, radius: number, offsetY: number): ShadowStyle => ({
    elevation: Platform.OS === 'android' ? elevation : 0,
    shadowColor,
    shadowOffset: { width: 0, height: offsetY },
    shadowOpacity: Math.min(opacity * opacityScale, 1),
    shadowRadius: radius,
  });

  return {
    0: level(0, 0, 0, 0),
    1: level(1, 0.06, 3, 1),
    2: level(3, 0.08, 6, 2),
    3: level(6, 0.1, 10, 3),
    4: level(12, 0.14, 20, 6),
  };
}

export const elevationFor = (scheme: ColorScheme): Record<0 | 1 | 2 | 3 | 4, ShadowStyle> => makeLevels(scheme);
