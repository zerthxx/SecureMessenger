/** Who besides the owner may see a birthday. The server enforces this; see server/src/lib/profile.ts. */
export type BirthdayVisibility = 'hidden' | 'month_day' | 'full';

/** The signed-in user's own profile, as returned by `users.me` / `users.updateProfile`. */
export interface OwnProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  /** ISO calendar date `YYYY-MM-DD`, or null when not set. */
  birthday: string | null;
  birthdayVisibility: BirthdayVisibility;
  avatarId: string | null;
}

/** Fields `users.updateProfile` accepts — only the ones present change; null clears bio/birthday. */
export interface ProfileUpdate {
  displayName?: string;
  bio?: string | null;
  birthday?: string | null;
  birthdayVisibility?: BirthdayVisibility;
}

/** The parts of a birthday its owner lets other people see. */
export interface PublicBirthday {
  month: number;
  day: number;
  year: number | null;
}

/** Another user's profile, as returned by `users.getProfiles`. */
export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarId: string | null;
  birthday: PublicBirthday | null;
}
