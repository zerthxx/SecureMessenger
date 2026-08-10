import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

interface SignupState {
  displayName: string;
  username: string;
  password: string;
  recoveryCode: string[];
}

interface SignupContextValue extends SignupState {
  setDisplayName: (value: string) => void;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  setRecoveryCode: (words: string[]) => void;
  reset: () => void;
}

const initialState: SignupState = { displayName: '', username: '', password: '', recoveryCode: [] };

const SignupContext = createContext<SignupContextValue | null>(null);

/**
 * Ephemeral in-memory wizard state for the mock signup flow. Password/recovery
 * data intentionally never touches navigation params — kept in memory only.
 */
export function SignupProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [state, setState] = useState<SignupState>(initialState);

  const value = useMemo<SignupContextValue>(
    () => ({
      ...state,
      setDisplayName: (displayName) => setState((s) => ({ ...s, displayName })),
      setUsername: (username) => setState((s) => ({ ...s, username })),
      setPassword: (password) => setState((s) => ({ ...s, password })),
      setRecoveryCode: (recoveryCode) => setState((s) => ({ ...s, recoveryCode })),
      reset: () => setState(initialState),
    }),
    [state],
  );

  return <SignupContext.Provider value={value}>{children}</SignupContext.Provider>;
}

export function useSignup(): SignupContextValue {
  const ctx = useContext(SignupContext);
  if (!ctx) {
    throw new Error('useSignup must be used within a SignupProvider');
  }
  return ctx;
}
