import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { db as Db } from '../../db/client.js';
import { devices, users } from '../../db/schema.js';
import { hashSecret, verifySecret } from '../../lib/password.js';
import {
  generateRecoveryCode,
  parseRecoveryCodeInput,
  recoveryCodeToString,
} from '../../lib/recoveryCode.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiryDate,
  signAccessToken,
  signRecoveryToken,
  verifyRecoveryToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from '../../lib/tokens.js';
import { spendRecoveryTokenJti } from '../../lib/recoveryTokenStore.js';
import { normalizeUsername, validateUsernameFormat } from '../../lib/username.js';
import { enforceRateLimit, protectedProcedure, publicProcedure, router } from '../trpc.js';

const deviceInput = z.object({
  name: z.string().trim().min(1).max(100),
  platform: z.enum(['ios', 'android', 'web']),
});

const usernameField = z.string().min(1).max(32);
const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(200);

// Computed once at startup: a valid-shaped Argon2id hash checked against
// on "user not found" so that path takes the same time as a real
// password check — see the "why" in `login` below.
const DUMMY_PASSWORD_HASH = await hashSecret(randomBytes(32).toString('hex'));

/**
 * Takes `db` as a parameter rather than reading it off a shared module
 * variable — this runs per-request, and a module-level mutable would be
 * a real race between concurrent requests (two logins interleaving could
 * write one request's refresh token onto the other's device row).
 */
async function issueSession(db: typeof Db, userId: string, deviceId: string) {
  const accessToken = await signAccessToken(userId, deviceId);
  const refreshTokenRaw = generateRefreshToken();
  const refreshTokenExpiresAt = refreshTokenExpiryDate();

  await db
    .update(devices)
    .set({ refreshTokenHash: hashRefreshToken(refreshTokenRaw), refreshTokenExpiresAt, lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));

  return {
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    refreshToken: refreshTokenRaw,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
  };
}

export const authRouter = router({
  /** Live availability check used by the Username step while the user types. */
  checkUsername: publicProcedure.input(z.object({ username: usernameField })).query(async ({ ctx, input }) => {
    const format = validateUsernameFormat(input.username);
    if (!format.valid) {
      return { available: false, reason: format.reason };
    }
    const normalized = normalizeUsername(input.username);
    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, normalized)).limit(1);
    return existing ? { available: false, reason: 'taken' as const } : { available: true as const };
  }),

  register: publicProcedure
    .input(
      z.object({
        username: usernameField,
        displayName: z.string().trim().min(1).max(50),
        password: passwordField,
        device: deviceInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      enforceRateLimit(`register:ip:${ctx.req.ip}`, 5, 60 * 60 * 1000);

      const format = validateUsernameFormat(input.username);
      if (!format.valid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            format.reason === 'reserved'
              ? 'That username is reserved.'
              : 'Username must be 3-20 characters: lowercase letters, numbers, underscore.',
        });
      }

      const normalizedUsername = normalizeUsername(input.username);

      const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, normalizedUsername)).limit(1);
      if (existing) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That username is already taken.' });
      }

      const passwordHash = await hashSecret(input.password);
      const recoveryCodeWords = generateRecoveryCode();
      const recoveryCodeHash = await hashSecret(recoveryCodeToString(recoveryCodeWords));

      const [user] = await ctx.db
        .insert(users)
        .values({
          username: normalizedUsername,
          displayName: input.displayName,
          passwordHash,
          recoveryCodeHash,
        })
        .returning({ id: users.id, username: users.username, displayName: users.displayName });

      if (!user) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create account.' });
      }

      const [device] = await ctx.db
        .insert(devices)
        .values({ userId: user.id, name: input.device.name, platform: input.device.platform })
        .returning({ id: devices.id });

      if (!device) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to register device.' });
      }

      const session = await issueSession(ctx.db, user.id, device.id);

      ctx.log.info({ userId: user.id, deviceId: device.id }, 'account registered');

      return {
        user: { id: user.id, username: user.username, displayName: user.displayName },
        device: { id: device.id },
        recoveryCode: recoveryCodeWords,
        session,
      };
    }),

  login: publicProcedure
    .input(z.object({ username: usernameField, password: z.string().min(1), device: deviceInput }))
    .mutation(async ({ ctx, input }) => {
      const normalizedUsername = normalizeUsername(input.username);
      enforceRateLimit(`login:ip:${ctx.req.ip}`, 10, 15 * 60 * 1000);
      enforceRateLimit(`login:user:${normalizedUsername}`, 10, 15 * 60 * 1000);

      const [user] = await ctx.db
        .select({ id: users.id, username: users.username, displayName: users.displayName, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.username, normalizedUsername))
        .limit(1);

      // Same generic error, same-shaped work either way — see DUMMY_PASSWORD_HASH.
      const genericError = () => new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect username or password.' });

      if (!user) {
        await verifySecret(input.password, DUMMY_PASSWORD_HASH);
        throw genericError();
      }

      const passwordOk = await verifySecret(input.password, user.passwordHash);
      if (!passwordOk) {
        throw genericError();
      }

      const [device] = await ctx.db
        .insert(devices)
        .values({ userId: user.id, name: input.device.name, platform: input.device.platform })
        .returning({ id: devices.id });

      if (!device) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to register device.' });
      }

      const session = await issueSession(ctx.db, user.id, device.id);

      ctx.log.info({ userId: user.id, deviceId: device.id }, 'login succeeded');

      return {
        user: { id: user.id, username: user.username, displayName: user.displayName },
        device: { id: device.id },
        session,
      };
    }),

  refresh: publicProcedure.input(z.object({ refreshToken: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const tokenHash = hashRefreshToken(input.refreshToken);
    const now = new Date();

    const [device] = await ctx.db
      .select({ id: devices.id, userId: devices.userId, refreshTokenExpiresAt: devices.refreshTokenExpiresAt })
      .from(devices)
      .where(and(eq(devices.refreshTokenHash, tokenHash), isNull(devices.revokedAt)))
      .limit(1);

    if (!device || !device.refreshTokenExpiresAt || device.refreshTokenExpiresAt < now) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired. Please log in again.' });
    }

    const session = await issueSession(ctx.db, device.userId, device.id);

    return { session };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(devices)
      .set({ revokedAt: new Date(), refreshTokenHash: null, refreshTokenExpiresAt: null })
      .where(and(eq(devices.id, ctx.device.id), isNull(devices.revokedAt)));

    return { success: true as const };
  }),

  logoutAllDevices: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await ctx.db
      .update(devices)
      .set({ revokedAt: new Date(), refreshTokenHash: null, refreshTokenExpiresAt: null })
      .where(and(eq(devices.userId, ctx.user.id), isNull(devices.revokedAt)))
      .returning({ id: devices.id });

    ctx.log.info({ userId: ctx.user.id, revokedCount: result.length }, 'signed out all devices');
    return { success: true as const, revokedCount: result.length };
  }),

  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1), newPassword: passwordField }))
    .mutation(async ({ ctx, input }) => {
      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }

      const currentOk = await verifySecret(input.currentPassword, user.passwordHash);
      if (!currentOk) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Current password is incorrect.' });
      }

      const newHash = await hashSecret(input.newPassword);
      await ctx.db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, user.id));

      // Changing the password revokes every OTHER device — this one stays
      // signed in, matching the Phase 1B screen's existing UX (success,
      // then back — no forced re-login on the device that made the change).
      // Excluding the current device from the WHERE clause (rather than
      // revoking-then-restoring it) matters: restoring only `revokedAt`
      // without also restoring its refresh token would leave this very
      // session unable to refresh once its short-lived access token expired.
      await ctx.db
        .update(devices)
        .set({ revokedAt: new Date(), refreshTokenHash: null, refreshTokenExpiresAt: null })
        .where(and(eq(devices.userId, user.id), isNull(devices.revokedAt), ne(devices.id, ctx.device.id)));

      ctx.log.info({ userId: user.id }, 'password changed');
      return { success: true as const };
    }),

  recovery: router({
    /**
     * Step 1 of account recovery: prove knowledge of the recovery code,
     * get back a short-lived, single-purpose token for step 2.
     *
     * IMPORTANT LIMITATION — read before touching this again: this token
     * only ever proves "reset my login password." It is not, and must
     * never become, a way to decrypt anything. Once E2EE ships, message
     * keys live only on-device; this recovery flow has no access to them
     * and isn't the mechanism to add that access through. See the Phase 2
     * ADR §08 tradeoff this was a deliberate choice, not an oversight.
     */
    verifyCode: publicProcedure
      .input(z.object({ username: usernameField, recoveryCode: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const normalizedUsername = normalizeUsername(input.username);
        enforceRateLimit(`recovery:ip:${ctx.req.ip}`, 5, 60 * 60 * 1000);
        enforceRateLimit(`recovery:user:${normalizedUsername}`, 5, 60 * 60 * 1000);

        const [user] = await ctx.db
          .select({ id: users.id, recoveryCodeHash: users.recoveryCodeHash })
          .from(users)
          .where(eq(users.username, normalizedUsername))
          .limit(1);

        const genericError = () => new TRPCError({ code: 'UNAUTHORIZED', message: 'That recovery code is not valid.' });

        if (!user) {
          await verifySecret(input.recoveryCode, DUMMY_PASSWORD_HASH);
          throw genericError();
        }

        const codeOk = await verifySecret(parseRecoveryCodeInput(input.recoveryCode), user.recoveryCodeHash);
        if (!codeOk) {
          throw genericError();
        }

        const { token: recoveryToken } = await signRecoveryToken(user.id);
        ctx.log.info({ userId: user.id }, 'recovery code verified');
        return { recoveryToken };
      }),

    /** Step 2: spend the recovery token once to set a new password and rotate the recovery code. */
    resetPassword: publicProcedure
      .input(z.object({ recoveryToken: z.string().min(1), newPassword: passwordField }))
      .mutation(async ({ ctx, input }) => {
        const verified = await verifyRecoveryToken(input.recoveryToken);
        if (!verified) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This recovery session has expired. Start over.' });
        }

        // Signature+expiry alone don't make a JWT single-use — spend the
        // jti so this exact token can't reset the password a second time.
        if (!spendRecoveryTokenJti(verified.jti)) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This recovery session has already been used. Start over.' });
        }

        const newPasswordHash = await hashSecret(input.newPassword);
        const newRecoveryCodeWords = generateRecoveryCode();
        const newRecoveryCodeHash = await hashSecret(recoveryCodeToString(newRecoveryCodeWords));

        await ctx.db
          .update(users)
          .set({ passwordHash: newPasswordHash, recoveryCodeHash: newRecoveryCodeHash, updatedAt: new Date() })
          .where(eq(users.id, verified.userId));

        // A password reset via recovery is treated like a compromise
        // signal — every device is signed out, including any attacker
        // session, and the account owner logs back in fresh.
        await ctx.db
          .update(devices)
          .set({ revokedAt: new Date(), refreshTokenHash: null, refreshTokenExpiresAt: null })
          .where(and(eq(devices.userId, verified.userId), isNull(devices.revokedAt)));

        ctx.log.info({ userId: verified.userId }, 'password reset via recovery code');
        return { success: true as const, newRecoveryCode: newRecoveryCodeWords };
      }),
  }),
});
