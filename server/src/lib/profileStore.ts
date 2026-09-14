import { eq, inArray } from 'drizzle-orm';

import type { db as Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ProfileStore } from './profile.js';

/**
 * Only the profile columns — password/recovery-code hashes and E2EE keys
 * are never selected here, so they can't reach a profile response even by
 * accident.
 */
const profileColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  birthday: users.birthday,
  birthdayVisibility: users.birthdayVisibility,
  avatarId: users.avatarId,
};

/** The Postgres-backed ProfileStore used by the users router and the avatar routes. */
export function createDbProfileStore(db: typeof Db): ProfileStore {
  return {
    async findById(userId) {
      const [row] = await db.select(profileColumns).from(users).where(eq(users.id, userId)).limit(1);
      return row ?? null;
    },

    async findByIds(userIds) {
      if (userIds.length === 0) return [];
      return db.select(profileColumns).from(users).where(inArray(users.id, [...userIds]));
    },

    async update(userId, patch) {
      const [row] = await db
        .update(users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(profileColumns);
      return row ?? null;
    },

    // Row-locked so two concurrent uploads each learn exactly which photo
    // they replaced — the caller deletes that blob afterwards.
    async setAvatar(userId, avatarId) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ avatarId: users.avatarId })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!current) return null;
        await tx.update(users).set({ avatarId, updatedAt: new Date() }).where(eq(users.id, userId));
        return { previousAvatarId: current.avatarId };
      });
    },
  };
}
