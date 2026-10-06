import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import Storage from 'expo-sqlite/kv-store';

import { colorSchemes, type ColorScheme, type SemanticColors } from './colors';
import { elevationFor } from './elevation';
import { radius } from './radius';
import { spacing } from './spacing';
import { typography } from './typography';

export type ThemePreference = ColorScheme | 'system';

export interface Theme {
  scheme: ColorScheme;
  colors: SemanticColors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  elevation: ReturnType<typeof elevationFor>;
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function buildTheme(scheme: ColorScheme): Theme {
  return {
    scheme,
    colors: colorSchemes[scheme],
    spacing,
    radius,
    typography,
    elevation: elevationFor(scheme),
  };
}

const PREFERENCE_KEY = 'theme_preference';

/**
 * The choice made in Settings → Appearance. It used to live only in memory,
 * so every restart quietly went back to "System". Read synchronously, so the
 * first frame already has the right colors.
 */
function storedPreference(): ThemePreference {
  try {
    const value = Storage.getItemSync(PREFERENCE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const systemScheme = useSystemColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      Storage.setItemSync(PREFERENCE_KEY, next);
    } catch {
      // Still applied for this session.
    }
  }, []);

  const scheme: ColorScheme = preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
  const theme = useMemo(() => buildTheme(scheme), [scheme]);
  const value = useMemo(() => ({ theme, preference, setPreference }), [theme, preference, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx.theme;
}

export function useThemePreference(): Pick<ThemeContextValue, 'preference' | 'setPreference'> {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useThemePreference must be used within a ThemeProvider');
  }
  return { preference: ctx.preference, setPreference: ctx.setPreference };
}
