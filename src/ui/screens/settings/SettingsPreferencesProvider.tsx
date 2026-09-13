import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

export interface SettingsPreferences {
  readReceipts: boolean;
  setReadReceipts: (next: boolean) => void;
  showLastSeen: boolean;
  setShowLastSeen: (next: boolean) => void;
}

const SettingsPreferencesContext = createContext<SettingsPreferences | null>(null);

/**
 * The Privacy toggles, shared by the full Settings screen and the dedicated
 * Privacy & Security screen so both show the same values. In-memory only —
 * neither is persisted or sent to the server yet. (Push notifications have
 * real state now and live in NotificationsProvider.)
 */
export function SettingsPreferencesProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [readReceipts, setReadReceipts] = useState(true);
  const [showLastSeen, setShowLastSeen] = useState(false);

  const value = useMemo(() => ({ readReceipts, setReadReceipts, showLastSeen, setShowLastSeen }), [readReceipts, showLastSeen]);

  return <SettingsPreferencesContext.Provider value={value}>{children}</SettingsPreferencesContext.Provider>;
}

export function useSettingsPreferences(): SettingsPreferences {
  const ctx = useContext(SettingsPreferencesContext);
  if (!ctx) {
    throw new Error('useSettingsPreferences must be used within a SettingsPreferencesProvider');
  }
  return ctx;
}
