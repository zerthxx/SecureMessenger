export type PasswordStrengthLabel = 'Too short' | 'Weak' | 'Fair' | 'Strong';

export interface PasswordStrength {
  score: number;
  label: PasswordStrengthLabel;
  tone: 'danger' | 'warning' | 'success';
}

/** Purely cosmetic client-side heuristic for UI feedback — not a security check. */
export function evaluatePasswordStrength(password: string): PasswordStrength {
  if (password.length < 8) {
    return { score: 0, label: 'Too short', tone: 'danger' };
  }
  let score = 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[A-Z]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  if (score <= 1) return { score, label: 'Weak', tone: 'danger' };
  if (score <= 2) return { score, label: 'Fair', tone: 'warning' };
  return { score, label: 'Strong', tone: 'success' };
}
