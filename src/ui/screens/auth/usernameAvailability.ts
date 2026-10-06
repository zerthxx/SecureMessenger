// Live "is this username free?" checking for the sign-up username step. Pure
// (no React Native imports) so the rules are unit tested
// (usernameAvailability.test.ts).
//
// Why this exists: the screen checked only when the text changed, but it
// stays mounted underneath the password steps. Coming back to it — say after
// the sign-up failed because someone took the name meanwhile — showed the
// old "Available" with Continue enabled, and an error could only be retried
// by editing the name.

export type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'error';

export type CheckResult = { available: boolean; reason?: string };

export const MIN_USERNAME_LENGTH = 3;
export const CHECK_DEBOUNCE_MS = 500;

/** What a server answer means for the screen. An unknown reason is treated as "not usable" rather than trusted blindly. */
export function stateFromResult(result: CheckResult): AvailabilityState {
  if (result.available) return 'available';
  switch (result.reason) {
    case 'taken':
    case 'reserved':
    case 'invalid':
      return result.reason;
    default:
      return 'invalid';
  }
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Checks the latest username after a pause in typing, and only ever shows
 * the answer for the name currently in the field: a slower answer for an
 * earlier name (or an earlier check of the same name) is dropped.
 */
export class UsernameAvailabilityChecker {
  private latest = '';
  private sequence = 0;
  private timer: unknown = null;
  private disposed = false;
  private readonly check: (username: string) => Promise<CheckResult>;
  private readonly onState: (state: AvailabilityState) => void;
  private readonly timers: Timers;
  private readonly debounceMs: number;

  constructor(
    check: (username: string) => Promise<CheckResult>,
    onState: (state: AvailabilityState) => void,
    timers: Timers = realTimers,
    debounceMs = CHECK_DEBOUNCE_MS,
  ) {
    this.check = check;
    this.onState = onState;
    this.timers = timers;
    this.debounceMs = debounceMs;
  }

  /** The field changed. */
  update(username: string): void {
    this.latest = username.trim();
    this.schedule(this.debounceMs);
  }

  /** Check the current name again now — the screen came back into view, or the person tapped "Try again". */
  recheck(): void {
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    this.sequence++;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const sequence = ++this.sequence;
    const username = this.latest;
    if (!username) {
      this.onState('idle');
      return;
    }
    if (username.length < MIN_USERNAME_LENGTH) {
      this.onState('invalid');
      return;
    }
    this.onState('checking');
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.run(sequence, username);
    }, delayMs);
  }

  private async run(sequence: number, username: string): Promise<void> {
    let state: AvailabilityState;
    try {
      state = stateFromResult(await this.check(username));
    } catch {
      state = 'error';
    }
    if (this.disposed || sequence !== this.sequence || username !== this.latest) return;
    this.onState(state);
  }
}
