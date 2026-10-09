# SecureMessenger — production-readiness checklist

Living document. Three lists: confirmed defects (with status), hypotheses
not yet confirmed, and blocked items. "Verified" means a test or a
reproduced run proved it, not that the code was read.

Last updated: 2026-10-09.

## Baseline at start of this pass (2026-10-09)

| Suite | Command | Result |
|---|---|---|
| Client unit | `npm test` (repo root) | 58/58 |
| Server unit | `npm test` (server/) | 146/146 |
| Rust mls-core | `cargo test --release` (modules/mls-core/rust) | 30/30 |
| Server integration (Postgres) | `E2EE_TEST_DATABASE_URL=… npm run test:integration` | needs Docker Postgres (not running at start) |

Working tree was clean apart from untracked `.codex/` and `.mcp.json`.

## A. Confirmed defects

### A1. Group rebuild replaces the native group before the server accepts it — CONFIRMED (code), fix in progress
- Where: `src/ui/screens/chat/ChatContext.tsx` `rebuildConversationGroup`.
- Mechanism: native `rebuildGroup` swaps this device's MLS group for the
  unpublished candidate while `mlsGeneration:<owner>:<conv>` still reads G.
  Until `resetGroup` is accepted, a send encrypts under the candidate but is
  tagged G, the server accepts it (conversation still at G), and every other
  device records it as `decryption_failed` ("Unable to decrypt", red) for good.
  The same mismatch persists after a `resetGroup` network failure (3 attempts
  then throw — native group stays the candidate, label stays G), and after a
  crash in that window. Received G messages then also fail locally (red) until
  the 60 s rebuild cooldown passes.
- Also: a voice message's envelope is encrypted after an `await` (the blob
  upload), so a rebuild in between encrypts the envelope under the new group.
- Fix: label the local generation 0 before the native rebuild, confirm it
  only after the server accepts; sends wait for the in-flight sync instead
  of encrypting; every `encryptMessage` re-checks the label it was sealed
  for. Regression tests: `groupSync.test.ts` (pure rules) + Postgres
  integration where applicable.

### A2. Voice blobs are decrypted through the MLS sender ratchet — CONFIRMED (OpenMLS source), fix in progress
- Where: `attemptSendVoiceNow` / `fetchVoiceAudio` (ChatContext), blob is
  `encryptMessage` output.
- Mechanism: OpenMLS `SenderRatchetConfiguration` default keeps 5 past keys.
  A blob fetched after 5 later messages from the same sender (download
  failed, device offline, tapped later) fails with `TooDistantInThePast`,
  and after any group rebuild the group is gone entirely. The UI shows
  "Couldn't load audio · Tap to retry" (red), and retry can never succeed.
- Fix: seal the blob with a random per-message content key (AES-256-GCM in
  mls-core: `seal_blob`/`open_blob`), carry the key inside the MLS-encrypted
  envelope. Old `SMVOICE1` envelopes without a key keep the legacy path.
  Needs the native library rebuilt (`cargo ndk`) and Kotlin bindings
  regenerated.

### A3. Timed-out but delivered send leaves a red bubble plus a grey phantom — CONFIRMED (code)
- Where: `syncConversation` `own_message_lost` branch + `reconcileSentMessageId`.
- Mechanism: the local row is `local-…` and `failed`; the sync fetches the
  server copy, doesn't find its id locally, records it as `unavailable`
  ("Sent before this device joined the chat"). Only tapping retry (same
  ciphertext → server dedupe) repairs it.
- Fix: the sync matches an own-device row against pending ciphertexts of
  local sending/failed rows and reconciles in place; `reconcileSentMessageId`
  must not delete an already-reconciled row. Bounded automatic retry of
  retryable send failures before marking `failed`.

## B. Hypotheses (not yet confirmed)
- B1. Production Supabase (free tier) pausing when idle makes every send
  fail (red) until restored — operational, verify with Supabase status.
- B2. `sendMessage` rate limit 60/min/device can be hit by fast bursts →
  TOO_MANY_REQUESTS → red "Failed to send".
- B3. Honor-device `StorageNotInitialized` (temporary diagnostics still in
  MlsCoreModule.kt / lib.rs) — unknown whether still occurring.

## C. Blocked / external
- Railway service `SecureMessenger` (read-only check 2026-10-09): latest deployment SUCCESS (2026-10-06, the v0.9.0
  server); build `npm run build`, start `npm start`, volume at `/data`, **no `healthcheckPath` configured** — set it
  to `/health/db` so a paused database makes the deployment unhealthy (config change: needs the user's approval).
- Production variables present: ACCESS_TOKEN_SECRET, ARGON2_PEPPER, DATABASE_URL, FCM_SERVICE_ACCOUNT_JSON,
  MEDIA_STORAGE_DIR, NODE_ENV. **No TURN_KEY_ID / TURN_API_TOKEN** → `calls.iceServers` returns STUN only: calls
  between phones behind symmetric NAT / carrier-grade NAT will fail to connect. Needs a TURN provider (Cloudflare
  TURN keys are what `lib/turnCredentials.ts` expects) — provisioning may cost money: user decision.
- Supabase project `bcepljgwxyatzsiaiwza`: ACTIVE_HEALTHY at check time (free tier still pauses when idle).
- Physical devices: none attached (`adb devices` empty). Emulator-only
  evidence will be labelled as such.
- Railway/Supabase production state: read-only checks only; no deploy
  without explicit approval.
- iOS: no Xcode here; Swift module stays unverified.

## D. Verified complete this pass

### Milestone 1 (2026-10-09 ~03:20) — A1/A2/A3 implemented, all suites green
Files changed (uncommitted — the user has not authorized commits):
- `modules/mls-core/rust/src/blob.rs` (new): AES-256-GCM content-key sealing for media blobs.
- `modules/mls-core/rust/src/lib.rs`: exports `generate_blob_key`, `seal_blob`, `open_blob`.
- `modules/mls-core/rust/src/regression_tests.rs`: `voice_blobs` module (ratchet-loss proof + sealed-blob tests).
- `modules/mls-core/android/.../MlsCoreModule.kt`, `uniffi/mls_core/mls_core.kt` (regenerated), `ios/generated/*` (regenerated), `src/MlsCoreModule.ts`, `src/MlsCoreModule.web.ts`, `src/infrastructure/crypto/mlsCore.ts`: the three new functions.
- `src/infrastructure/media/voiceEnvelope.ts` (+test): envelope moved out of ChatContext, optional `key`.
- `src/infrastructure/network/transientFailures.ts` (+test): `isRetryableApiFailure`.
- `src/infrastructure/crypto/groupSync.ts` (+test): `resolveRebuildCandidate`, `findPendingSendForRow`.
- `src/infrastructure/storage/messageStore.ts`: `audio_key` column, `setVoiceBlob`, `listPendingOutgoingIds`, rebuild-candidate app-state, idempotent `reconcileSentMessageId`.
- `src/ui/screens/chat/ChatContext.tsx`: generation label 0 + candidate marker around native rebuild; candidate resolution in `maintainGroup`; `encryptForGeneration` guard; bounded transient send retries; sync reconciles lost-response sends; voice blobs via content keys (legacy path kept for keyless envelopes); send loop stops when the row was confirmed meanwhile.
- `src/ui/components/MessageBubble.tsx`: `unavailable` label now "Not available on this device" (was misleading for own-message/candidate cases).
- `server/src/trpc/routers/e2ee.ts`: `listConversations.groupBuiltByThisDevice` (additive), `sendMessage` limit 60→120/min.
- `server/src/trpc/routers/e2ee.integration.test.ts`: test for `groupBuiltByThisDevice`.

Native library: rebuilt with `cargo ndk -t arm64-v8a -t x86_64 -o ../android/src/main/jniLibs build --release`
(jniLibs are gitignored — **any APK build must be preceded by this command on the committed Rust source**),
bindings via `cargo run --release --features uniffi/cli --bin uniffi-bindgen -- generate --library target/x86_64-linux-android/release/libmls_core.so --language kotlin|swift --out-dir …`.

Results (actual):
| Suite | Result |
|---|---|
| `cargo test --release` | 33/33 |
| `npm test` (client) | 66/66 |
| `npx tsc --noEmit` (client, server) | clean |
| `npm test` (server unit) | 146/146 (before server edits; re-run pending) |
| `E2EE_TEST_DATABASE_URL=postgres://test:test@127.0.0.1:15432/sm_test npm run test:integration` | 38/38 (container `sm_test_pg`) |

Compatibility notes: an old server (prod runs cf0b2fc) lacks `groupBuiltByThisDevice` → the client treats a pending candidate as `discard` (one extra rebuild, no red). Old clients receiving a keyed voice envelope parse the known fields, try the MLS path and show "Couldn't load audio" — the next release must be `mandatory` in the manifest.

### Milestone 2 (2026-10-09 ~03:30) — emulator verification (Pixel 6 API 36 ×2, local server + dev Postgres)
Setup: `docker start secure-messenger-pg`; `cd server && npx tsx src/index.ts`; Metro with
`EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --dev-client`; `adb reverse tcp:4000/8081` on both;
debug APK from `./gradlew assembleDebug` (BUILD SUCCESSFUL 1m22s) installed on emulators A (5554) and C (5556).
Accounts: Carol (existing, C) and dave0910 (registered during the run, A).

| Scenario | Result |
|---|---|
| Sign-up on A (display name → username availability → password → confirm → recovery code → confirm words) | works |
| C starts chat with Dave; text C→A and A→C | delivered, read, no red |
| Voice A→C (hold-to-record 3.5 s) | playable on C; stored blob starts with 0x01 (content-key format) |
| A2 reproduction: C force-stopped, A sends clip + 6 texts, blob hidden on server, C relaunched | C shows "Couldn't load audio · Tap to retry" (server 404); after restoring the blob, tap retry → playable. Under the old ratchet design this retry could never succeed (Rust test `the_ratchet_path_loses_a_clip_fetched_after_five_later_messages`). |
| App restart recovery (force-stop + relaunch on C) | history intact, sync resumes |
| New-device rebuild: `pm clear` on A, log in as Dave again, chat opens | A rebuilt generation 2, C joined; gen-1 history shows grey "Not available on this device" on A (correct), post-rebuild messages readable both ways; nothing red; server log shows 0 STALE refusals, 2 "group established" |

Not reproduced on device: the exact send-during-rebuild timing window (A1) — the fix is covered by the pure rules
(`resolveRebuildCandidate`) and the ChatContext control flow; no emulator-timed race was achieved.
Emulator caveats learned: airplane mode and `adb reverse --remove` do NOT cut an existing localhost tunnel; use
`am force-stop` to simulate offline. Not physical-device evidence.

Observed, not yet fixed: a wiped/reinstalled device's old `devices` row stays addressable (it never signed out), so
rebuilds keep sending it Welcomes and consuming its KeyPackages until its session TTL expires (B4).

### Milestone 3 (2026-10-09 ~03:45) — sign-out / re-login cycle, ordering, previews, dependencies
| Scenario | Result |
|---|---|
| Burst of 5 from C after the rebuild | all 5 on A, in order, no duplicates |
| Dave signs out on A (Profile → Sign out → confirm) | device row revoked server-side; within the 5-min membership check Carol's device rebuilt (generation 3, built by her device); C stayed "Encrypted", nothing red |
| Dave logs in again on A (same install, data kept) | new device row; A rebuilt generation 4; cached history still readable; text A→C and C→A on gen 4 delivered both ways |

Fixes added this milestone:
- `messageStore.refreshConversationPreview`: own sent/sending texts now preview their content (showed "Message").
- `server`: fastify 5.11.3 → 5.12.5 (5 advisories: DoS on HTTP/2 trailers, validation/auth bypasses); unit 146/146 after.
- Client `npm audit --omit=dev`: 33 advisories, all in expo/react-native ranges whose only "fix" is a major downgrade (expo 44, RN 0.72) — not actionable; re-check after the next Expo SDK upgrade.
- Unfinished features: Stories and Groups tabs are `href: null` (hidden); `/settings/blocked-contacts` route exists — check whether Settings links to it (next).

### Milestone 4 (2026-10-09 ~03:45) — server hardening
- B4 fixed: `isAddressableDevice` now also requires `last_seen_at` within `ADDRESSABLE_IDLE_MS` (30 days). A wiped
  or abandoned phone stops receiving Welcomes / having KeyPackages consumed; a live device returning later rebuilds.
  Integration test: `B_STALE` fixture refused as Welcome recipient, no KeyPackage handed out, absent from
  `listConversationDevices`. Suite 38/38.
- fastify 5.11.3 → 5.12.5 changed `trustProxy` semantics: a numeric hop count now trusts nothing (fail closed) and
  the type no longer allows it. `resolveTrustProxy` now returns `false` for a hop count and `app.ts` warns at startup
  (`trustProxyHopCountIgnored`). Production uses the Railway CIDR list, so it is unaffected. Unit 146/146, tsc clean.
- Voice playback UI (carried over from the previous session as "stuck on Play / 0:00"): NOT a defect on this build.
  With logs at all three layers (expo-audio status → `voicePlayer.onStatus` → `useVoicePlaybackState` → bubble render)
  every layer updated, and a real screenshot mid-playback shows the Pause icon, the progress bar and "0:01 / 0:08".
  What was stale is `uiautomator dump`: it does not reflect text/label changes of nodes whose structure didn't change,
  which is almost certainly what the earlier report observed too. Temporary logs removed. Lesson recorded in memory:
  verify visual state with `screencap`, not only the accessibility dump.

### Milestone 8 (2026-10-09 11:44–12:14) — scripted 30-minute two-device reliability run (actual duration 30 min)
Same driver and verifier as Milestone 7, with the relaunch fixed (deep link) and a 30-minute budget. Events: Erin
backgrounded/resumed at 11:46/11:47 and 11:54/11:54; bursts of 5 at ~11:48 and ~11:58; Dave screen off/on ~11:49;
server killed 11:55:20, back 11:55:37; Dave force-stopped 11:57:48, relaunched 11:58:32 and kept sending.
Results from both caches: Dave→Erin 89 sent / 89 read, Erin→Dave 66 sent / 66 read, order monotonic both ways,
0 duplicates, 0 `decryption_failed`, 0 `failed`; server 156 application rows in the window, 0 STALE refusals,
0 duplicate sends. Driver artifacts (not app defects): 7 Erin sends never issued because the voice step raised the
microphone permission dialog (RECORD_AUDIO had been reset by the earlier wipe) and the app sat on the Chats list
until I reopened the chat at 11:55; the voice clip therefore did not record either. Not an hours-long run.

## E. Handoff — refreshed 2026-10-09 ~13:50 (supersedes E2, E1, E0 below where they differ)

**State of the tree (uncommitted, nothing deployed):** server unit 146/146,
server integration 40/40 (2 new), client 67/67, client and server `tsc`
clean, Rust 33/33 (unchanged since the last run). Whole diff reviewed file
by file this round (section F.4 and the earlier A-items are the only
intended behaviour changes; no plaintext fallback, no MLS weakening, retries
bounded everywhere). Untracked and NOT produced by this work: `.codex/`
(Sep 11) and `.mcp.json` (Supabase MCP config with the project ref) — decide
whether to ignore or commit them. `scripts/loadtest/results/*.json` are
evidence files (no tokens or secrets in them); gitignore or keep.

**This round (scale mission):** section F. Three server fixes, all local:
sendMessage 7 → 2 statements (F.4.1), `DB_POOL_MAX` + pool stats in
`/health/db` (F.4.2), and the pool `error` handler that stops a dropped
database connection from killing the process (F.4.3 — the most important
production fix found so far: a Supabase pause would have crashed the API).
One client fix: backed-off, jittered polling while the realtime socket is
down (F.4.4, `pollSchedule.ts`, verified on emulators with the new
`E2EE_TEST_REALTIME_DOWN=1` hook). Harness, latency proxy and a README under
`scripts/loadtest/`. Test status after all of it: server unit 147/147,
server integration 40/40, client 72/72, both `tsc` clean.

**Decisions for the user (not made here):** `DB_POOL_MAX` for Railway (needs
the Supabase connection limit and whether the URL is the pooler); database
co-location (S3); the poll-storm mitigation (S1) is a client change that
would ship with v0.10.0; multi-instance architecture (S2) before any 25k+
target. Still no commit/deploy/release authorization assumed.

**Emulator reruns (2026-10-09 ~13:40, dev server restarted on today's
server code first):** live session revocation re-verified — Dave's main
device (AVD A) opened Devices → the online second session → Terminate →
confirm; the second device (AVD C) showed "You were signed out — This
session was ended…" within 2 s, the server logged `session terminated`, and
its next call was refused with "Session expired". Erin's original test
account password could not be recovered from the notes, and resetting it in
the dev database was blocked by the tool policy, so the second device now
has a fresh account (Erin2 / erin1009) for the voice and reliability reruns.

Voice round trip re-verified on the new content-key path: Erin2 → Dave and
Dave → Erin2 clips both arrived as `kind voice, status decrypted/sent,
audio_state downloaded, audio_key present` in each device's own SQLite cache
(not just on screen), first text Dave → Erin2 decrypted on Erin2. Playback
itself was not re-verified this round: a screenshot 1.6 s after tapping play
still read 0:00 / 0:03 (the earlier round verified playback by screenshot;
the emulator's audio start can be slow) — re-check after the run.

30-minute two-device run, 13:47–14:17, Dave (AVD A) ↔ Erin2 (AVD C), dev
server on today's server code: 78 iterations, 156 driver sends; verified
from both SQLite caches afterwards: Dave → Erin2 87 sent / 87 read, Erin2 →
Dave 68 / 68, none missing, 0 red, 0 duplicates, per-sender order monotonic
on both sides, the voice clip "sent" on Erin2 and "decrypted/downloaded" on
Dave; through Erin2 backgrounded/resumed three times, two 5-message bursts,
Dave screen off/on, the server killed and back after 1 s (13:58), and Dave
force-stopped and relaunched (14:00–14:01). The driver logged four
"SENDFAIL (no send button)" on Erin2 right after its voice step: its
keyboard-dismiss Back had navigated out of the chat (a driver artefact, not
an app failure — Dave's messages kept arriving, the chat preview updated);
reopening the chat resumed her sends. Results file: `$TMP/rel.log`.

Poll backoff wired and verified (F.4.4). 10-minute two-device run on the new
polling code with realtime up, 14:27–14:37 (`$TMP/rel2.log`), verified from
both caches by time window: Dave → Erin2 30 sent / 30 read, Erin2 → Dave
18 / 18, 0 missing, 0 duplicate ids, 0 red, per-sender order intact on both
sides, through backgrounding and a 5-message burst (the 10-minute variant
ends before the driver's server-kill and force-stop steps). The driver's
voice step again left Erin2 on the Home screen (five "SENDFAIL" lines after
it) and this time produced no voice row at all. Reproduced by hand: a
long-press on Erin2's mic produced and sent a 0:02 clip, she stayed in the
chat, and the keyboard was not reported shown afterwards — the app is fine.
The driver's `send` helper presses Back 0.3 s after Send (keyboard still
animating away) and its voice step pressed Back again with no keyboard
open, which is what left the chat before the long-press. Driver patched
(voice step no longer presses Back); not an app defect. That hand-sent clip
reached Dave (`decrypted / downloaded / key present / 2947 ms`) and
**playback is now verified by screenshot**: pause icon shown and the progress
bar advanced 1.2 s after tapping play (the "0:00" position label lags the
bar, which is why the earlier text dumps read 0:00).

S2 design note written (F.8), S5 shedding sketched (decision needed), S7
sized from real clip bytes. Final full pass at ~14:45: client 72/72 + tsc,
server 147/147 unit, 40/40 integration, tsc clean; Rust 33/33 unchanged
since its last run (no Rust edits this round).

Third run, patched driver, 14:43–14:54 (`$TMP/rel2.log`, 24 iterations,
51 driver sends, 0 send failures): Dave → Erin2 29 / 29, Erin2 → Dave
22 / 22, 0 missing, 0 duplicate ids, 0 red, order intact both ways, and the
scripted voice clip `sent` on Erin2 and `decrypted / downloaded / key
present / 3090 ms` on Dave — so the voice step is now exercised end to end
by the driver. During this run the host ran out of memory (a 13 GB
unrelated process plus the two emulators; 0.5 GB free): Claude Code stopped
the Metro bundler and the run's waiter; the apps kept running on their
loaded bundle and the run finished. Both emulators were then shut down
(2.6 GB free afterwards). **Metro is not running** and was deliberately not
restarted; start it again (`EXPO_PUBLIC_API_URL=http://localhost:4000 npx
expo start --dev-client --port 8081`) before the next device session. The
dev server on :4000 (today's code, no hooks) is still up.

**Next in the loop:** the S5 decision; if wanted, a Linux/second-machine
load run above 1k active users (F.9). No commit, deploy or release without
authorization.

## E2. Handoff — refreshed 2026-10-09 ~12:20 (superseded above)
Since the 10:15 handoff: Priority 1 analysed and narrowed (pre-rebuild final sync + `rebuildStillApplies`, unit test
+ device regression), Priority 2 verified on the real UI, Priority 3 states checked, Priority 4 run of 30 minutes
done. Suites: client tsc clean + 67/67; server tsc clean + 146/146 + 38/38 (10:12, server code unchanged since);
Rust 33/33 (unchanged). Processes still running: server (no hooks), Metro, emulators 5554 (AVD A, Dave) and 5556
(AVD C, Erin), both DB containers. Exact next action unchanged: whole-diff review, then the user's commit decision;
production items (health check, TURN, v0.10.0) documented, not applied.

## E1. Handoff — refreshed 2026-10-09 ~10:15 (superseded above)

Git: branch `main`, HEAD 6cdac0e, **nothing committed** (no authorisation). Working tree: 29 modified files
(+1027/−178) plus new `docs/`, `modules/mls-core/rust/src/blob.rs`, `server/src/lib/testHooks.ts`,
`src/infrastructure/media/voiceEnvelope.ts`, `src/infrastructure/media/voiceEnvelope.test.ts`. `jniLibs/*.so`
rebuilt (gitignored). Untracked `.codex/` and `.mcp.json` are the user's, untouched.

Suites, last run ~10:12 (actual): client tsc clean, `npm test` 66/66; server tsc clean, `npm test` 146/146,
integration 38/38 (container `sm_test_pg`); Rust 33/33 (run earlier, unchanged since).

Red-message investigation status (per the user's instruction it stays OPEN until judged otherwise):
- Reproduced deterministically with server fault injection: lost `resetGroup` response, server slower than the
  45 s client timeout, process killed inside the window, concurrent sends from the other side inside the window.
  In every run: no `decryption_failed`, no duplicate, no lost message; the rebuilding device recovered through
  the candidate note (1.4 s after relaunch, logged) and never created a surplus generation.
- Not reproducible from the UI any more: a send from the rebuilding device inside the window (composer disabled
  while the label is 0). Still open for a decision: messages the other party sends into the old generation during
  a window are grey on the rebuilding device when its credential is new (by MLS design); for an existing credential
  that rebuilds (unreadable / signed-out-member triggers) the old group is deleted by the rebuild, so those
  in-window messages are also grey there — never red. If that is unacceptable, the rebuild must snapshot the old
  group until the server accepts the new one (native change).
- No red state was produced in any run of this session (A1/A2/A3 fixes in place).

Processes left RUNNING at this handoff (local only): server `npx tsx src/index.ts` on :4000 (no test hooks),
Metro :8081, emulators 5554 (AVD C, signed in as erin0910) and 5556 (AVD A, dave0910), containers
`secure-messenger-pg` and `sm_test_pg`. Stop: kill the node PIDs on 4000/8081, `adb -s <serial> emu kill`,
`docker stop sm_test_pg secure-messenger-pg`. Serial↔AVD mapping changes across boots — check `avd_name`.

Exact next action: review `git diff` once more as a whole, then ask the user for commit authorisation. After that,
in order: Railway `healthcheckPath=/health/db` (approval), TURN credentials decision, v0.10.0 mandatory release
plan, removal of the Honor-device diagnostics (approval).

## E0. Earlier handoff (2026-10-09 ~03:50)

Final results this pass (all actual runs, last at ~08:45 after Milestone 5): Rust `cargo test --release` 33/33 ·
client `npm test` 66/66 · client `npx tsc --noEmit` clean · server `npm test` 146/146 · server `npx tsc --noEmit`
clean · server integration 38/38 · debug APK built and exercised on two emulators (Milestones 2–5).
Files touched since Milestone 3 (also uncommitted): `src/infrastructure/network/trpcClient.ts` (httpLink),
`src/infrastructure/notifications/pushNotifications.ts`, `src/ui/screens/settings/NotificationsProvider.tsx`,
`src/ui/screens/ChatsScreen.tsx`, `src/ui/screens/chat/ChatContext.tsx` (registration flag), `server/src/trpc/routers/e2ee.ts`
(registration limits 60/h), `package.json` (native scripts). Test account on the dev DB: `erin0910` (AVD C).

Working tree (uncommitted; commits need the user's go-ahead): 24 modified files + new `docs/`,
`modules/mls-core/rust/src/blob.rs`, `src/infrastructure/media/voiceEnvelope.ts(+test)`. `jniLibs/*.so` are rebuilt
but gitignored. New root scripts: `npm run native:build`, `native:bindings`, `native:test`.

Also exercised: the message list's older-page loading (conversation grown to 53 rows > `MESSAGE_PAGE_SIZE` 50;
scrolling C to the top reaches "Hello from carol 1").

Processes: everything I started was stopped at handoff (Metro, the local API server, emulators A and C, Docker
containers `sm_test_pg` and `secure-messenger-pg`). Docker Desktop itself was started by this session and left
running. To resume device testing: `docker start secure-messenger-pg`; `cd server && npx tsx src/index.ts`;
`EXPO_PUBLIC_API_URL=http://localhost:4000 npx expo start --dev-client`; boot the AVDs; `adb reverse` 4000 and
8081 on each; the debug APK with the new native library is at `android/app/build/outputs/apk/debug/app-debug.apk`
(A is signed in as dave0910, C as Carol; both installs keep their state).

Exact next tasks, in order:
1. Review the diff once more as a whole (`git diff`), then ask the user to authorize a commit.
2. Confirm Railway's health check targets `/health/db` (readiness), not `/health` (liveness) — `/health` stays
   "ok" while the paused Supabase DB 500s every call.
3. DONE — live session revocation: Dave signed in on both A and C (multi-device, same account); from A → Settings →
   Devices → the C session → Terminate → confirm. Within 6 s C showed "You were signed out — This session was ended…"
   with the Log in button, and the DB row was revoked. (Same-account second device also reached the chat list.)
4. Still open: a longer multi-device run (both of Dave's devices exchanging with Carol over hours, membership
   checks, KeyPackage top-ups) — needs time, not new code.
5. Remove the Honor-device TEMPORARY diagnostics in `MlsCoreModule.kt` / `lib.rs` once the user confirms that
   investigation is closed.

### Milestone 5 (2026-10-09 ~08:40) — background delivery, notifications, setup rate limit
Setup for this round: Dave on AVD A, a fresh account `erin0910` on AVD C (Carol's password is unknown).
- Server restart with both apps open: both devices re-upgraded `/realtime`; a message sent right after the
  restart reached the other device in ~3 s. Access-token expiry: 0 × 401 in the whole run — the realtime client
  refreshes proactively before expiry.
- **A5 — no background sync at all (CONFIRMED, FIXED).** A realtime hint reached the backgrounded app
  (`AppState` "background"), but the `fetchMessages` HTTP request only completed when the app resumed (logged
  08:33:08 start → 08:33:23 done, exactly at resume). Root cause: tRPC `httpBatchLink` dispatches via
  `setTimeout(dispatch)` (`@trpc/client/dist/httpBatchLink-*.mjs`), and React Native on Android does not run JS
  timers while the app is paused. Fix: `httpLink` (direct fetch; the app never batches). After the fix: hint → fetch
  (20 ms) → decrypt → notification "Dave / New message", all while backgrounded; message present on resume.
- **A6 — open chat muted notifications even in the background (FIXED):** `presentNewMessageNotification` and the
  foreground handler now suppress only when the conversation is on screen AND `AppState` is active.
- **A7 — no notification permission prompt for new accounts (FIXED):** Android 13+ needs POST_NOTIFICATIONS; the app
  asked only from Settings → Notifications. Both emulators had `granted=false`. Now asked once after sign-in
  (`push_notifications_prompted` flag), never if the in-app preference is off.
- **A8 — "Too many attempts" killed encrypted messaging after ~10 app launches/hour (FIXED):** every launch re-sent
  the idempotent `registerIdentityKey`/`registerDeviceCredential` (10/h/device). Client now registers once per
  device row (`e2eeRegistered:<user>:<device>` flag); server limits raised to 60/h; the Chats screen keeps the
  cached conversations visible with a tappable banner instead of replacing the list with the error.
- Device-testing lesson: launching via the dev-client deep link reloads the JS bundle (resets session state); resume
  with `am start -n com.securemessenger.app/.MainActivity`.

### Milestone 6 (2026-10-09 ~09:40) — deterministic rebuild-race runs (server fault injection)
New dev-only hooks in `server/src/lib/testHooks.ts` (ignored in production): `E2EE_TEST_RESET_GROUP_DELAY_MS`
(delays `resetGroup`) and `E2EE_TEST_DROP_RESET_RESPONSES` (commits, then destroys the connection). Runs, each
started by wiping Dave's app data (new MLS credential → rebuild on login), with Erin's device live throughout:
| Run | What happened | Outcome |
|---|---|---|
| Lost response (delay 60 s + drop) | server committed gen 3 (built by Dave's device) and dropped the answer; client's `resetGroup` timed out (45 s) and retried | Dave adopted gen 3 via `builtByThisDevice`; Erin's later messages readable on Dave; Dave's message readable on Erin; **no extra generation** |
| Slow server (delay 60 s > 45 s client timeout) | three client timeouts, then the candidate note resolved against the server | adopted gen 4, no gen 5; Erin's two messages sent inside the window are grey "Not available" on the new credential (correct: that credential never held gen 3); nothing red |
| Process killed inside the window (delay 20 s, kill at +8 s, relaunch at +33 s) | server committed gen 5/6 while the process was dead | on relaunch `resolveRebuildCandidate` → `adopt` within 1.4 s (logged), message delivered to Erin, no extra generation |
| Send from the rebuilding device inside the window | composer is disabled ("Waiting for encryption to be ready…", header "Setting up encryption…") while the label is 0 | no send can be issued, hence no fork; programmatic sends (startup retries) wait for the slot |
Also found and fixed: `refreshConversations` published the chat list only after awaiting every per-conversation
sync (a rebuild window long), so a freshly signed-in device showed "Tap the compose icon…" — now published first.
Known, accepted limitation: messages the other side sends into the OLD generation during a rebuild window are
unreadable on the rebuilding device when its credential is new (grey, never red). Measurement caveat: `uiautomator`
dumps lag text changes; recovery timings here come from logs, not dumps.

### Milestone 7 (2026-10-09 09:41–10:02) — scripted 20-minute two-device reliability run
Driver: `reliability.sh` (scratchpad), log `rel.log`; verification `verify_rel.mjs` pulls both devices' SQLite caches
(`adb exec-out run-as … cat files/SQLite/mls_chat_cache.db`) and cross-checks them with `node:sqlite`.
Timeline (local): 09:41:47 start · sends from both devices every ~21 s · 09:43:44/09:51:33 Erin backgrounded,
resumed 09:44:22/09:52:10 · 09:46:08 and 09:51 bursts of 5 · 09:47:13 Dave screen off → on 09:47:27 · 09:52:54
server killed, back ~09:53:11 · 09:55:20 Dave force-stopped · 10:02:06 end (53 iterations).
Results (verified from the caches, not the UI): Dave→Erin 41 sent / 41 read, Erin→Dave 47 sent / 47 read, order
monotonic both ways, 0 duplicates, 0 `decryption_failed`, 0 `failed`; server: 88 application rows in the window,
0 STALE refusals, 0 duplicate sends. The 15 Erin messages sent after 09:55:41 were read on Dave only after a proper
relaunch at 10:05 — because the driver's `am start -n …MainActivity` after a force-stop opens the Expo dev-launcher,
not the app (the app was simply not running; backgrounded resumes via MainActivity do work). The driver's voice
clip at iteration 20 did not record (hold position while the keyboard was open) — voice was verified separately.
Not an hours-long run: 20 minutes of continuous traffic.

### Task 4 — notifications on a fresh install (2026-10-09 ~10:10)
`pm clear` on Erin's device (POST_NOTIFICATIONS back to `granted=false`), log in again: the first attempt showed no
dialog — after a wipe expo-notifications reports the never-asked state as `denied` (can ask again), not
`undetermined`, so the sign-in prompt now fires for either (never for `blocked`). Second attempt: "Allow Secure
Messenger to send you notifications?" appeared at once after sign-in; Allow → `granted=true`. Existing account on
Dave's device: already granted, no prompt. Open-chat muting: verified earlier in Milestone 5 — muted only while the
conversation is on screen with the app in the foreground; backgrounded with the chat open → notification posted.
Registration budget: app relaunch no longer sends `registerIdentityKey`/`registerDeviceCredential` (server log count
unchanged across relaunches); limits raised to 60/h as a second guard.

### Priority 1 (2026-10-09 ~11:25) — why in-window messages are grey on the rebuilding device
Two distinct cases, settled by reading `rust/src/group.rs` and the sync rules:
1. **New credential** (fresh install / wiped data): the device never held the old generation's keys; MLS forward
   secrecy makes those messages undecryptable for it. Expected missing key material, not a defect; the grey
   "Not available on this device" is the honest state. Not recoverable without weakening MLS (no plaintext fallback).
2. **Existing credential rebuilding for membership hygiene** (`signed_out_member`): the device could still read the
   current generation, but `rebuild_group` deletes it before the server accepts the new one — OpenMLS keeps one
   group per id and the id is bound into the group context, so two generations cannot coexist. Messages the other
   side sent between this device's last sync and that deletion are lost for this device only (grey, never red).
   Recoverable part: the preparation phase (device listing + KeyPackage consumption, 1–2 round trips) sat between
   the sync and the deletion. Fix: `rebuildConversationGroup` now runs a final `syncConversation` right before the
   native rebuild and abandons the rebuild if that sync joined a newer Welcome (`groupSync.rebuildStillApplies`,
   unit-tested). Remaining window: the native call itself plus server row visibility (tens of ms).
   Not recoverable: messages that reach the server after that instant but before `resetGroup` commits (they are
   tagged with the old generation and the server accepts them); the other side's own copy is unaffected, every
   other device of both members reads them. Risk: low frequency (membership-hygiene rebuilds only), one device,
   grey not red. Eliminating it fully needs a native change that snapshots the old group until the server accepts.

Priority 1 verification (11:36–11:45): my first version of the guard compared the local generation with the
server's and therefore abandoned every rebuild (caught by the device regression: generation stayed 8, nothing
delivered). Corrected to "did the final sync change the local generation" (`localGenerationBeforeSync` vs
`…AfterSync`, test rewritten, 67/67). Device regression after the fix: wiped Dave → login → rebuild to generation 9
(Welcomes to Erin and the stale Dave rows) → Erin→Dave and Dave→Erin delivered on generation 9.

### Priority 3 (2026-10-09) — chat list visibility and screen states
- Chat list no longer hidden while conversations synchronise: observed in the race runs (Dave could open the Erin
  chat ~9 s after login while the rebuild was still pending; header "Setting up encryption…", composer disabled
  with "Waiting for encryption to be ready…").
- Loading: `LoadingState` only until the first sync completes with no cached rows. Empty: "No messages yet". Error:
  Chats banner (Priority 2) when cached chats exist, `ErrorState` with Retry when none. Retry/recovery: banner clears
  on the 30 s setup retry (observed 11:32). Suites after the changes: client tsc clean, 67/67.

### Round 4 (2026-10-09 ~12:30) — permissions, voice, revocation (partial)
- `RECORD_AUDIO` and `POST_NOTIFICATIONS` granted on both emulators via `adb shell pm grant` (test-setup only; app
  manifest/runtime handling unchanged); the driver now grants them at start.
- Voice Erin→Dave re-verified from Dave's persisted cache: `decrypted/downloaded`; both bubbles "0:00 / 0:02".
- Live revocation re-run was interrupted by the user before the terminate step. Device state left: 5556 (AVD C) is
  signed in as Dave's **second session**, Erin is signed out there; 5554 (AVD A) is Dave's main session on the
  Chats list. (Live revocation itself was verified in Milestone 3.)

### Priority 2 (round 3) — can the remaining rebuild window be eliminated? Design analysis, NOT implemented
Constraint: OpenMLS stores one `MlsGroup` per `GroupId`, and the id is part of the group context (key schedule
input), so the old and the candidate generation cannot both exist in one storage provider under the same id, and
the candidate cannot be built under a temporary id and renamed.
Option A — whole-store rollback: `GroupProvider` already snapshots the entire in-memory SQLite database for its
checkpoint (`snapshot_memory_db_to_bytes`). Take that snapshot before `rebuild_group`, restore it if the server
refuses/never answers. REJECTED: the snapshot also rolls back every other group's ratchets advanced meanwhile,
resurrecting decryption keys that forward secrecy had erased — a security regression, and `decrypt_message_once`'s
pending-plaintext table would also revert.
Option B — per-group rollback: snapshot/restore only the rows of that `GroupId` across the provider's tables
(group state, epoch key pairs, message secrets, proposals, own leaf …, plus `app_pending_plaintext`). Feasible but
needs exact knowledge of `openmls_sqlite_storage`'s schema and of which tables carry per-epoch secrets; a mistake
re-introduces erased keys silently. Not attempted without a Rust test that proves the restored group re-derives
nothing it had erased.
Option C — build the candidate in a separate temporary provider (second in-memory DB + same signer), send its
Welcome, and only on `resetGroup` acceptance delete the old group in the main provider and import the candidate via
`MlsGroup::store(main.storage())`. Cleanest semantics (old group stays readable until the server has accepted the
new one; nothing is ever restored, so no erased key comes back), but the import must also carry the epoch key pairs
and signature key the group references; whether `store` alone suffices in openmls 0.8.1 must be proven by a Rust
test (encrypt/decrypt both ways after import, and a replay check) before any app use.
Recommendation: Option C, behind a Rust regression test, in its own change; until then the window is the native
call + server row visibility (tens of ms), one device only, grey never red.

### Priority 2 VERIFIED (2026-10-09 11:29–11:32) — Chats banner with the server down
Exact steps run on Erin's device (AVD C): server stopped 11:28:59 → app force-stopped and relaunched via the Metro
deep link → dev sheet dismissed → Chats tab → at 11:31:17 the UI showed, above the search field and the Dave row:
"Encrypted messaging unavailable · Couldn't reach the server. Check your connection and try again. Tap to retry."
(dump and screenshot `E_banner5.png`). Server restarted 11:31:23 → at 11:32:08 the banner was gone and the list
intact (row back at its normal position; screenshot `E_banner6.png`). Environmental failures of the earlier
attempts (dev sheet, adb daemon wedge, dropped tunnels) were not app defects. Fixed on the way: the banner's
accessibility label doubled the final period.

### Earlier partial note (superseded): Chats banner with the server down (2026-10-09 ~10:28)
Server stopped, Erin's app relaunched: Home and the Chats tab both rendered from the local cache with the Dave
conversation listed and the search field present — the old behaviour (whole list replaced by the error state) is
gone. The banner's text was not captured in three attempts: (1) the dev-client sheet stalled the dump; (2) a manual
server restart overlapped the check's own restart; (3) the adb daemon wedged mid-run and had to be killed, which
also drops every `adb reverse` tunnel, so the dev client could no longer reach Metro (load error + ANR). Tunnels
restored afterwards. Environment artifacts only; the list-preserving behaviour was observed each time. Re-run to see the banner text:
stop server → relaunch → dismiss the dev sheet ("Continue") → Chats tab → expect "Encrypted messaging unavailable ·
… Tap to retry." above the list → start server → banner gone within the 30 s setup retry.

### Review of release mechanics, TURN, signing and migrations (tasks 5–7, read-only)
- Mandatory update: server `CURRENT_UPDATE_MANIFEST.mandatory` → client `UpdateDialog` is non-dismissable with no
  "Later" button when mandatory (`dismissable = (!mandatory && !busy) || status === 'incompatibleSignature'`); the
  banner hides its dismiss control. v0.10.0 needs `versionName`/`versionCode` (10), `apkUrl`, `sha256` filled in
  after the APK exists; `/update-manifest` serves it. Order: server deploy → APK build (after `npm run native:build`)
  → GitHub release → manifest commit → verify `/download/…` hash.
- `/health/db` pings the database (503 when unreachable); `/health` is liveness only. Railway has no
  `healthcheckPath` set (describe-service) — recommended `/health/db`; not changed.
- TURN: `calls.iceServers` → `getIceServersForDevice` → Cloudflare provider only when `TURN_KEY_ID` and
  `TURN_API_TOKEN` are set; otherwise `STUN_ONLY` (`stun:stun.cloudflare.com:3478`), `calls.status.relayConfigured`
  false. Production variable names show neither key → every production call is direct-only; calls between phones
  behind symmetric/carrier-grade NAT (most mobile data) will fail at ICE. Testable without credentials: unit tests
  of `turnCredentials.ts` (exist), and the client's `EXPO_PUBLIC_DEV_FORCE_TURN_RELAY=1` relay-only mode with
  `DEV_ICE_SERVERS_JSON` against any TURN server. Needs a decision: provision Cloudflare TURN (may cost).
- Signing: `android/app/build.gradle` uses `keystores/keystore.properties` → `secure-messenger-release.keystore`
  (new key since 2026-08-12; pre-v0.5.0 installs cannot update in place — documented in `keystores/KEYSTORE_INFO.md`);
  falls back to the debug key only when the properties file is absent. Verify the release APK cert SHA-256
  (4f908d90…) before publishing.
- Migrations: journal ends at `0007_mls_generations`; no new migration this pass (only `audio_key` in the *client*
  SQLite, added by `ensureColumn`). Production applied 0007 manually and Drizzle's bookkeeping table is empty there,
  so `npm run db:migrate` must NOT be run against production.
- Native build reproducibility: `npm run native:build` (cargo-ndk 4.1.2, NDK 27.1.12297006, targets arm64-v8a +
  x86_64), `npm run native:bindings` (uniffi 0.32 → Kotlin + Swift), `npm run native:test`. Verified this pass:
  release `.so` for both ABIs contain `uniffi_mls_core_fn_func_seal_blob`; Gradle `assembleDebug` BUILD SUCCESSFUL.

### Release plan for v0.10.0 (NOT executed — needs the user's approval)
1. Commit this tree (user authorizes). 2. Deploy server first: `listConversations.groupBuiltByThisDevice` is additive and
the client tolerates its absence; `sendMessage` limit change is server-only. 3. `cd modules/mls-core/rust && cargo ndk -t arm64-v8a -t x86_64 -o ../android/src/main/jniLibs build --release`
(jniLibs are gitignored; the APK must contain the new `seal_blob`/`open_blob` symbols — verify with
`grep -c uniffi_mls_core_fn_func_seal_blob` on the .so). 4. Bump `app.json` version/versionCode, build the release APK
with the production cert (SHA-256 4f908d90…), verify package id and checksum. 5. Publish the manifest as **mandatory**:
old clients render keyed voice envelopes as "Couldn't load audio" until updated. Production DB needs no migration.

---

## F. Scale readiness (100,000-user mission, 2026-10-09)

Nothing here was run against production. Every figure is labelled
**measured** (executed locally, numbers from logs/harness), **derived**
(arithmetic from measured inputs), **estimated** (judgement, needs a test)
or **unknown**. Nothing at 10k/25k/50k/100k concurrent has been executed:
the largest runs so far are 500 idle sockets and 200 users with traffic.

### F.1 Request path (client → recipient)

1. App → `POST /trpc/e2ee.sendMessage` (httpLink, 45 s client timeout, 2 bounded
   transient retries with 2–8 s backoff) → Fastify → tRPC `protectedProcedure`
   (JWT verify, no DB; `sessions.isActive` = 1 statement per device per 30 s;
   `touch` = 1 statement per device per 60 s, not awaited) → in-memory rate
   limiter (120/min/device) → handler → pg `Pool` → Postgres.
2. Handler stores the opaque ciphertext, then (not awaited) publishes a
   content-free `conversation.updated` hint through the in-memory realtime hub
   (1 statement to find member devices) and the FCM fan-out (1 statement +
   FCM HTTP per device with a token).
3. Recipient app: hint on its WebSocket → `GET /trpc/e2ee.fetchMessages` (2
   statements) → native MLS decrypt → SQLite cache. Without a hint it polls:
   open chat every 3 s (30 s when the socket is up), chat list every 6 s (30 s).

### F.2 Harness (`scripts/loadtest/`)

- `run.mjs`: registers N throwaway users (unique `X-Forwarded-For` each; run
  the server with `TRUST_PROXY=loopback` so per-IP limits see N clients), pairs
  them, sets up generation 1 with an opaque Welcome, opens one authenticated
  WebSocket per user (20 s ping like the app), then every user sends `--rate`
  messages/min of unique random ciphertext for `--duration` s while receivers
  fetch on every hint (`--fetch-every 1`). Reports client-observed
  p50/p95/p99, hint latency, errors, timeouts, socket drops/reconnects, and
  for every conversation duplicates / per-sender ordering / missing rows.
  `--sockets-only` holds idle sockets for memory measurements. Refuses
  production-looking hosts. Results in `scripts/loadtest/results/*.json`.
- `latency-proxy.mjs`: TCP proxy adding a fixed delay each way between the
  server and Postgres, to reproduce the production topology (API on Railway
  us-west, Supabase eu-west-1, ~150 ms round trip) on a laptop.
- Server-side percentiles come from the Fastify request log (`LOG_LEVEL=info`,
  `responseTime`); the harness's client-side numbers on Windows loopback include
  connection artefacts and are only comparable within one run.
- Environment: disposable `sm_test_pg` (Docker, :15432) + a dedicated server
  on :4100 (direct) / :4200 (through the proxy). Production, the Railway
  deployment and the Supabase project were not touched.

### F.3 Measured results

| Run | Setup | sendMessage (server) | fetchMessages (server) | Delivered / lost / dup / out-of-order | Pool | RSS |
|---|---|---|---|---|---|---|
| 20 users, 30 s, 6 msg/min | local DB | p50 10 ms (client p50 26 / p95 511 — loopback artefact) | p50 2 ms | 59 / 0 / 0 / 0 | ≤2 | 203→188 MB |
| 60 users, 60 s, fetch on every hint | local DB | p50 10, p99 22 ms | p50 2, p99 5 ms | 357 / 0 / 0 / 0 | ≤4 | — |
| 200 users, 60 s (17 sends/s + 23 fetches/s) | local DB | p50 10, p95 15, p99 20, max 27 ms | p50 2, p99 7 ms | 1194 / 0 / 0 / 0 | peaked at 10 (the max), waiting not sampled | 200→259 MB |
| 500 idle sockets, 60 s (+500 keep-alive HTTP sockets) | local DB | — | — | 500/500 sockets stayed open | — | 206→271 MB |
| 50 users, 60 s, **before** send-path fix | 150 ms RTT proxy, pool 10 | **p50 1094, p95 1251 ms** (7 statements) | p50 313 ms (2 statements) | 272 / 0 / 0 / 0 | ≤2 | — |
| 50 users, 60 s, **after** send-path fix | 150 ms RTT proxy, pool 10 | **p50 314, p95 471 ms** (2 statements) | p50 313 ms | 287 / 0 / 0 / 0 | ≤10 | — |
| 200 users, 60 s, after fix | 150 ms RTT proxy, **pool 10** | **p50 6431, p95 10840 ms** (queueing), 10.1 sends/s delivered of ~20 offered | p50 5382 ms | 792 / 0 / 0 / 0 | **pinned at 10 for the whole run** | 233→304 MB |
| 200 users, 60 s, after fix | 150 ms RTT proxy, **pool 40** | p50 313, p95 470, p99 487 ms, 16.5 sends/s | p50 312 ms | 1161 / 0 / 0 / 0 | peak 40, `waiting` 0 in every sample | 240→326 MB |

Other measured points behind the 150 ms proxy (server-side p50): `auth.register`
715 ms (argon2 + ~4 statements), `registerIdentityKey` 480–640, `createConversation`
1100 (7 statements), `resetGroup` 1255 (8 statements), `/health/db` 160.
Argon2id as configured (19 MiB, t=2) costs ≈ 30 ms server time per register
locally (measured p50 29–32 ms including 4 local statements).

Correctness under load: in every run every stored message was fetched by the
other member exactly once, in per-sender order, with no duplicates and no
losses, including the run that queued to 11 s. Overload today shows up as
latency, not as errors.

### F.4 Root causes found and fixed (local only, not deployed)

1. **sendMessage did 7 sequential statements** (device check, membership,
   BEGIN, duplicate pre-check, generation lock, insert, COMMIT). With the
   database 150 ms away that is ~1.1 s per send and ~0.45 s of pool time per
   send. Now 2 statements: one joined authorization check (device active +
   member, device first as before) and one `INSERT … SELECT … FROM
   conversations WHERE id = $1 AND mls_generation = $2 FOR SHARE ON CONFLICT DO
   NOTHING RETURNING`. Same atomicity with `resetGroup` (`FOR UPDATE`; under
   READ COMMITTED a lock wait re-evaluates the WHERE on the committed row, so a
   send that waited for a reset inserts nothing), same idempotency (a retry
   after a group change still resolves to the original row), same error codes
   (`UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT` stale generation,
   `PRECONDITION_FAILED` update required). A 3rd statement runs only for a
   duplicate or a stale generation. Measured: p50 1094 → 314 ms behind the proxy.
   Regression tests: all existing generation/idempotency/race tests (38) plus
   a new one, "only an active device of a member can send" (non-member →
   FORBIDDEN, revoked device → UNAUTHORIZED, unknown device → UNAUTHORIZED,
   nothing stored). Server: 39/39 integration, 146/146 unit, tsc clean.
2. **Pool size was hard-coded to 10** and invisible. Now `DB_POOL_MAX`
   (default 10, unchanged behaviour) and `GET /health/db` reports
   `pool: { max, total, idle, waiting }` plus `latencyMs`; `waiting > 0` is the
   signal that the pool (or the database's distance) is the bottleneck.
   Measured: 200 users went from p50 6.4 s (pool 10) to 313 ms (pool 40).
   **Production decision needed (not made):** the right `DB_POOL_MAX` depends
   on the Supabase plan's connection limit and whether `DATABASE_URL` points at
   the pooler (6543) or the direct port (5432): the sum over all instances must
   stay under that limit. Unknown from here; check the Supabase dashboard
   before setting it.

4. **Fixed fast polling while the realtime socket is down (S1).** Client:
   `src/infrastructure/network/pollSchedule.ts` (pure, 5 unit tests) and
   its wiring in `ConversationScreen.tsx` / `ChatContext.tsx`: with the
   socket up, the 30 s cadence ±25 % jitter (a fleet reconnecting after a
   deploy no longer polls in lockstep); with it down, 3 → 6 → 12 → 24 → 30 s
   per quiet poll for the open chat (6 → 12 → 24 → 30 for the chat list),
   reset by the app coming to the foreground, a poll that found messages,
   or the person's own send. Verified on the emulators with the dev server
   started with `E2EE_TEST_REALTIME_DOWN=1` (new production-gated hook in
   `lib/testHooks.ts`, 503 on every upgrade; regression test
   `lib/testHooks.test.ts`): Dave's fetch gaps after opening the chat were
   ~14, 23, 36, 29, 28, 28 s (the 3 s and 6 s steps were coalesced into the
   still-running initial sync by the per-conversation sync slot, so the
   series began at the 12 s step); both devices' chat-list polls settled at
   25–30 s; a message from the idle side reached Dave in 12 s, Dave's reply
   reached the active side in 4 s, and after each send the sender's polls
   restarted fast (5, 7, 11 s gaps) before backing off. Fleet effect
   [derived]: an idle 10k-client fleet in a realtime outage now settles to
   ~330 statements/s instead of ~8,000.

### F.5 Capacity model (single instance, current architecture)

- **Statement capacity [derived]** = `DB_POOL_MAX ÷ round-trip time`. At
  150 ms: pool 10 ≈ 66 statements/s (measured collapse at ~90 offered), pool
  40 ≈ 266/s. At 1 ms (database next to the API): pool 10 ≈ thousands/s and
  the CPU becomes the limit instead.
- **Statements per online user per second, socket up [derived from code]**:
  chat list every 30 s (1) + session check every 30 s (1) + open chat fetch
  every 30 s (2) + touch every 60 s (1) ≈ 0.12–0.15. Per message sent ≈ 2
  (send) + 1 (hint lookup) + 1 (push lookup) + 2 per recipient device fetch ≈
  6.
- **Statements per online user per second, socket down [derived]**: open
  chat every 3 s (2) + chat list every 6 s (1) ≈ 0.8. **A realtime outage
  turns 10k online users into ~8,000 statements/s — the poll storm is the
  most likely way a partial failure becomes a total one** (risk S1 below).
- Worked figures at 150 ms RTT (pool 40 ≈ 266 statements/s): ≈ 1,500
  online users idle, or ≈ 1,000 online users exchanging 1 message per user per
  5 min [derived]. At 1 ms RTT the same pool carries far more and the limit
  moves to CPU: ≈ 1–2 ms of Node time per request [estimated from the 10 ms
  local p50 which includes 2 local statements] → 500–1,000 requests/s per
  process → ≈ 10k online users at the 30 s cadences is about one core.
- **Memory [measured, upper bound]**: ≤ 65 KB per open socket (65 MB for
  1,000 sockets: 500 WebSockets + 500 keep-alive HTTP; the heap had not been
  compacted, so the true WebSocket cost is lower). 10k sockets ≈ ≤ 650 MB
  above the ~200 MB baseline; 100k sockets ≈ ≤ 6.5 GB → several instances
  regardless of CPU [derived].
- **Target tiers [derived, none executed]**: 10k concurrent: feasible on one
  larger instance only with the database co-located (or a pool sized for the
  RTT) and the poll-storm risk handled. 25k–100k: multiple instances are
  required, which the current architecture does not support (S2, S3).

### F.6 Risks and bottlenecks, ranked

- **S1 (high → mitigated locally, ships with the next client release) Poll
  storm when the realtime socket is down** [derived, fix verified on
  emulators]. Was: `POLL_MS` 3000 / `CONVERSATIONS_POLL_MS` 6000 fixed
  cadence whenever the socket was down, so a hub restart or a deploy made
  every client a 3-second poller. Now: backed-off, jittered polling (F.4.4).
  Until that client version is on every phone, the old clients still storm;
  server `429 Retry-After` under pool pressure remains the server-side
  option for that window.
- **S2 (high) Single process holds the realtime hub and the rate limiter in
  memory** [code]. A second instance would not receive the first one's hints
  (recipients fall back to polling) and would double every rate limit. Needs
  a shared bus (Postgres `LISTEN/NOTIFY` or Redis) and a shared limiter before
  any horizontal scaling. Security must not weaken with more instances: the
  limiter is the piece that would.
- **S3 (high) Database distance** [measured]: 150 ms per statement makes
  every multi-statement path slow (`createConversation` 1.1 s, `resetGroup`
  1.25 s, `register` 0.7 s) and multiplies the pool requirement by ~150.
  Co-locating the API and the database (same region) is the single largest
  capacity lever; it changes no code.
- **S4 (medium) Supabase free tier pauses when idle and has a small
  connection limit** [memory file + unknown exact limit]. Any pool above ~10
  must be checked against it.
- **S5 (medium) Overload is silent**: requests queue inside the process until
  the client's 45 s timeout; no shedding, no `Retry-After`. `/health/db` now
  exposes the queue. A bounded pool acquire timeout was considered and not
  added: with the client's bounded retries it would convert queueing into
  retry amplification without a `Retry-After` contract. Sketch of the
  shedding option (not implemented, needs a product decision on what to
  degrade first): in `protectedProcedure`, when `pool.waitingCount` exceeds
  a threshold, answer the *poll* procedures (`listConversations`,
  `fetchMessages` without a realtime hint) with `TOO_MANY_REQUESTS` and a
  `Retry-After` of 5–30 s while letting sends and auth through; the client
  already treats 429 as transient and its polls now back off anyway, so the
  only new client work would be honouring `Retry-After`. Measured basis: at
  pool 10 behind the proxy, `waiting` crossed 100 within 20 s of overload.
- **S6 (medium) FCM fan-out and push lookup per message** [unknown
  throughput]: not awaited, so it cannot slow a send, but at 100 msg/s it is
  100 FCM HTTP calls/s from one process; failures are logged and dropped
  (recipients still get the message on next sync).
- **S7 (low today, blocking at scale) Media on a 5 GB Railway volume**.
  Measured from the dev server's media directory (20 sealed clips): a ~3 s
  clip is 15–22 KB, the largest test clip 74 KB, ≈ 7 KB per second of
  audio; the client caps recordings at 120 s (`MAX_RECORDING_MS`) ≈ 0.9 MB
  and the server at 3 MB per blob (`http/media.ts`). Derived: the volume
  holds ≈ 180k average clips; 100k users sending one 10 s clip a day (~75 KB)
  is ~7.5 GB per day, so the volume fills in under a day at that scale.
  Needs a retention rule (clips are unreadable to the server, so a time- or
  count-based deletion is the only option) and/or object storage before any
  10k-user target; also not replicated (F.8).
- **S8 (low) Registration/login CPU** [measured]: ≈ 30 ms argon2 per
  attempt; a 1,000/min sign-up wave is ~50% of one core; per-IP limits (30/h
  register, 60/15 min login) bound abuse but not a legitimate surge.
- **S9 (low) `fetchMessages` membership check is a separate statement**
  [measured, 2 statements]: folding it into the rows query would save 150 ms
  per fetch behind the proxy but would make "not a member" indistinguishable
  from "no rows" unless returned differently; left as is.

3. **A lost idle database connection crashed the whole server process.**
   Found by the outage test below: pg's `Pool` emits `error` for an idle
   client whose backend goes away; with no listener Node treats it as an
   uncaught exception. Log: `Error: Connection terminated unexpectedly …
   Emitted 'error' event on BoundPool instance … throw er; // Unhandled
   'error' event`, after which every request was refused and all 60 sockets
   dropped. In production that is what a Supabase pause/restart, a pooler
   recycling connections or a network blip would do (Railway restarts the
   process, every client reconnects and polls = S1). Fix: `pool.on('error')`
   in `db/client.ts` logs through the app logger (`setPoolErrorLogger` from
   `index.ts`) and the pool opens fresh connections on the next query.
   Regression test: "losing the idle database connections does not kill the
   process, and the pool recovers" (terminates every other backend with
   `pg_terminate_backend`, then queries again). Before the fix that test
   file failed at file level with the unhandled error; after it: 40/40.

### F.7 Failure and recovery tests

| Scenario (local, through the 150 ms proxy, 60 users, 120 s) | Result before fix 3 | Result after fix 3 |
|---|---|---|
| Database unreachable for 15 s mid-run (proxy killed at 95 s, restarted at 110 s) | **Server process died** on the first idle-connection error; 260 sends + 60 fetches got `ECONNREFUSED`; all 60 sockets dropped and retried 3,300 times in the remaining 25 s (the reconnect storm); no recovery without a process restart | Process stayed up; 90 sends during the gap failed with a clean `500 Failed query` before any write (the app's bounded retries would resend them; nothing half-stored); `/health/db` returned 503 `unreachable` with `pool.total 0`, then `ok` again ~10 s after the proxy came back with no restart; 0 lost / 0 duplicate / 0 out-of-order among the 610 accepted sends; 0 socket drops |
| Overload: 200 users against pool 10 | p50 6.4 s queueing, 0 errors, 0 loss (above) | — (pool size now configurable) |
| Server process killed and restarted with 200 authenticated sockets held (local DB) | — | Process gone for ~6 s + ~8 s startup; all 200 sockets re-established within the first 10 s sample after listening; the harness's naive 1 s retry made 1,400 attempts in the gap (7 per socket). The app's `realtimeClient.ts` backs off 1 s × 2ⁿ with ±25 % jitter, capped at 30 s, so its storm is ~4 attempts per client over the same gap. Each reconnect costs the server 1 session statement, and the app's post-reconnect sync adds ~3 more per client [derived]: after a deploy with 10k online clients that is ~40k statements inside ~30 s, ≈ 2 minutes of queueing at 150 ms RTT with pool 40 (S1). |

| Pool exhaustion: 200 users against `DB_POOL_MAX=10` behind the proxy, `/health/db` sampled every 10 s | — | `pool.waiting` rose 0 → 9 → 126 → 185 → 207 → **224** while `total 10 / idle 0`; the health check itself took 1.9–3.7 s (it queues like everything else); sends p50 6.3 s, p95 10.8 s, 10.1/s delivered; 0 errors, 0 lost / dup / out-of-order; `waiting` back to 0 within 10 s of the load ending. So a load balancer using `/health/db` would see latency, not a 503, during pure overload. |

Still to run: FCM provider failure (not awaited on the send path, so expected
to be log-only); any run at 1k+ active users (needs a second machine or a
Linux host — this Windows loopback setup distorts client-side timing above
a few hundred connections).

### F.8 Design note: what a second API instance needs (S2, not implemented)

Everything below is per-process state today; with two instances behind
Railway's load balancer each item misbehaves in the way noted. None of it
changes the E2EE model (the server still only routes opaque bytes).

| State | Today | With 2+ instances | Smallest sound replacement |
|---|---|---|---|
| Realtime hub (`realtime/hub.ts`): which device is connected where, `conversation.updated` hints | in memory | a hint published on instance A never reaches a device connected to B; it falls back to polling (now backed off, so slow but correct) | Postgres `LISTEN/NOTIFY` on a `realtime` channel: each instance publishes `{conversationId, deviceIds}` (content-free) and every instance delivers to its own sockets. No new infrastructure; NOTIFY payload limit 8 kB is ample. Redis pub/sub is the alternative if Postgres stays far away (NOTIFY also costs one round trip). |
| Call registry (`realtime/callRegistry.ts`): ringing/active call state and signaling relay | in memory | caller on A, callee on B: invite never relayed | same bus for signaling frames (they are sealed, size-bounded), with call state keyed by `callId` in a shared table or Redis; or sticky routing by account, which Railway does not offer |
| Session cache (`lib/sessions.ts`: `verifiedAt`, `revoked`, `touchedAt`) | in memory, 30 s re-check | a session terminated on A keeps working on B for up to 30 s (`VERIFIED_CACHE_MS`) — bounded, already the documented worst case | broadcast terminations over the same NOTIFY channel so B drops the socket at once, as A does today |
| Rate limiter (`lib/rateLimit.ts`) | in memory | every limit is N× looser (each instance counts its own share) — the security property that degrades | Postgres-backed fixed windows (`insert … on conflict do update` counter per key+window; 1 statement) or Redis `INCR` with TTL; keep the in-memory limiter as a first, cheaper layer |
| Registration replay cache (`lib/registrationReplay.ts`) | in memory | a retried sign-up landing on the other instance is a "username taken" instead of the original answer — the `registrationId` protection weakens | store the outcome in Postgres keyed by `registrationId` (it is already idempotent by design) |
| Media (`MEDIA_STORAGE_DIR`, Railway volume) | one volume | a clip uploaded through A is not on B's disk | object storage (S3-compatible) behind the same `mediaStorage.ts` interface; also solves S7 |
| Session sweep / cron-like timers (`index.ts`) | every instance | runs N times; harmless (idempotent) but wasteful | `pg_try_advisory_lock` around the sweep |

Order of work when it becomes necessary: rate limiter and registration
replay first (security), then the NOTIFY bus for hints + session
terminations, then calls and media. Each step is independently testable
with the harness by running two servers on different ports behind a tiny
round-robin proxy.

### F.10 Scale hardening continuation (2026-10-09, afternoon)

Evidence gathered this round (read-only; nothing in Railway or Supabase was
changed):

- **Production database round trip, measured**: `GET /trpc/system.health`
  on the live API reports its `SELECT 1` time: 143, 143, 143, 144, 144,
  143 ms over six samples (the proxy used locally, 72–75 ms each way, was
  the right model).
- **Connection mode, determined from the database side**: while the API
  served requests, its backend showed up in `pg_stat_activity` as
  `application_name = "Supavisor"` from the pooler's address — the API
  reaches Postgres through Supabase's pooler, not a direct connection.
  Whether that pooler URL is transaction mode (port 6543) or session mode
  (5432 on the pooler host) could not be read: Railway redacts variable
  values for this connection. Transaction mode is Supabase's default pooler
  URL and is compatible with everything the server does today (single
  statements, `db.transaction` blocks pinned to one connection,
  transaction-scoped advisory locks, unnamed prepared statements) but NOT
  with `LISTEN/NOTIFY`, which matters for F.8.
- **Postgres limits, read from `pg_settings`**: `max_connections 60`,
  `superuser_reserved_connections 3`, `statement_timeout 120 s`,
  `shared_buffers` 224 MB, `work_mem` 2 MB (the smallest Supabase compute).
  Resident backends besides the API: PostgREST 1, postgres_exporter 1,
  Supavisor auth 1–2, pg_net worker 1, management API 1 when the dashboard or
  MCP is used — about 6.
- **Railway service**: 1 replica in `sfo`, limits 8 vCPU / 8 GB, 72-hour
  average 145 MB memory and ~0 CPU; auto-deploys `main`.

#### F.10.1 Database pool budget

Because the API goes through Supavisor, `DB_POOL_MAX` is a count of
*pooler client connections*, and Postgres-side backends are bounded by the
pooler's own `default_pool_size` (15 on the smallest computes [Supabase
documentation default; not readable from here]). The pooler sits next to
the database, so once a statement has crossed the 144 ms to the pooler it
occupies a backend for ~1 ms: 15 backends can serve far more than 40 client
connections. The 144 ms is paid per statement by the *client* connection,
which is why the client-side pool size sets the ceiling (F.5).

Budget (direct-connection worst case, in case the URL is ever switched to
port 5432 on the database host): 60 − 3 reserved − ~6 resident − 2 for
`railway run` / migrations / MCP = **49 usable**, shared by every API
instance. With one instance: `DB_POOL_MAX` ≤ 40 leaves 9 spare; ≤ 30 leaves
19 for a second instance or a burst of admin sessions.

The comparison runs (100 users behind the 144 ms proxy, 60 s, pool sizes
10/20/30/40 with shedding off) are appended below as F.10.5 when they
finish.

**Recommendation (evidence-based, conservative, not applied):**
`DB_POOL_MAX=30` for the single Railway instance. 30 ≈ 200 statements/s at
144 ms (F.5), which carried the 200-user runs with no queue; it stays within
the direct-connection budget even if the URL is changed; and it leaves
room for a second instance (2 × 20) before any pooler limit is approached.
`DB_SHED_WAITING` can stay at its default (2 × pool = 60). Assumptions to
verify before setting it: the pooler's `max_client_conn` and
`default_pool_size` in the Supabase dashboard (Project → Database →
Connection pooling), and that the URL is the pooler's.

#### F.10.2 Co-location of API and database

Measured: 143–144 ms per statement from Railway `sfo` to Supabase
`eu-west-1`. Everything multi-statement inherits it: `createConversation`
1.1 s, `resetGroup` 1.25 s, `register` 0.7 s, a send 0.3 s after F.4.1, a
fetch 0.3 s; and the pool requirement scales with it (F.5: capacity =
pool ÷ RTT). Two ways to remove it:

| Option | Effect on RTT | Complexity / risk | Cost |
|---|---|---|---|
| Move the Railway service to a European region (Railway offers `europe-west4`) | Supabase stays; ~10–20 ms expected [estimated: same-continent] | Railway region change = redeploy with a new egress; the volume (`/data`, voice clips, 5 GB) is region-bound and must be migrated or recreated; app clients unaffected (same domain); downtime of one deploy | within current plan [unknown exact] |
| Move the database next to the API (Railway Postgres in `sfo`, or Supabase `us-west`) | ~1 ms | a full database migration: dump/restore of all tables, a cut-over window with writes stopped, new `DATABASE_URL`, loss of Supabase extras (pooler, dashboard, backups unless re-created), credential rotation | new database costs |

Security: both keep TLS to the database and change nothing in the E2EE
model (the server never reads message content). Reliability: a Railway
region move changes the egress IP (no allow-list exists today) and the
volume; a database move changes backups and the free-tier pause behaviour
(a paid Postgres does not pause, which also removes the "idle → 500s"
failure in the memory notes).

**Recommendation:** co-locate before any further scaling work, and do it
by **moving the API to Railway's EU region** first: it is the cheaper,
reversible change (no data migration), removes ~140 ms from every statement
and every pool requirement by ~10×, and leaves Supabase's pooler and
backups in place. The volume migration is the one real task. Revisit a
database move only if a European Railway region proves slow or the
free-tier pause stays unacceptable. Not done: no infrastructure change was
made.

#### F.10.3 Load shedding (S5), implemented locally

Behaviour under overload now (`lib/overload.ts`, `sheddableProcedure` in
`trpc/trpc.ts`): while more than `DB_SHED_WAITING` (default 2 ×
`DB_POOL_MAX`; 0 disables) requests are waiting for a pooled connection,
`listConversations`, `fetchMessages` and `keyPackageStatus` are refused at
once with `TOO_MANY_REQUESTS` + `Retry-After` 5–30 s (growing with the
queue depth), *before* the session check, so a shed call does no database
work. Sends, auth, session changes, group setup and the realtime socket
are never shed: accepted messages are never dropped (the insert is
idempotent and the app's bounded retries resend a timed-out send). Client
side: the poll loops already back off and jitter (F.4.4) and treat 429 as
transient, so no app change is required; honouring `Retry-After` exactly
would be an improvement for a later version. Tests: `lib/overload.test.ts`
(policy, 5), integration "under pool overload, polling is shed with
Retry-After while a send still goes through and is stored once" and "pool
exhaustion is visible as a wait queue and drains by itself" (recovery
without restart). The measured effect at 100 users / pool 10 behind the
proxy is in F.10.5.

#### F.10.4 Multi-instance work order (from F.8), dependency-ordered

Prerequisite: the single instance must be stable at its target load first
(this round's fixes), and the database co-located (F.10.2) — otherwise a
second instance only doubles the pool requirement.

1. **Shared rate limiter** (security first): Postgres-backed fixed windows
   (`insert … on conflict do update` per key+window, 1 statement) behind
   the existing `checkRateLimit` interface, with the in-memory limiter kept
   as the first layer. Test: two servers on different ports behind a
   round-robin proxy, the harness's per-IP registration limit must hold
   across both.
2. **Registration replay in Postgres**: store the outcome keyed by
   `registrationId` (already idempotent by design). Test: retry lands on
   the other instance and gets the original answer.
3. **Hint and session-termination bus**: Postgres `LISTEN/NOTIFY` requires
   a *direct* (non-transaction-pooled) connection for the listener — one
   dedicated connection per instance outside the pool, or Redis if the
   pooler URL must stay transaction mode. Payload: `{conversationId,
   deviceIds}` and `{terminatedDeviceId}`; each instance delivers to its own
   sockets. Test: send on A, hint received on B's socket; terminate on A,
   B's socket closes.
4. **Push notifications**: already stateless per request (FCM from the
   handling instance); only the device-token lookup is shared via the
   database — no change, but verify after step 3 that a recipient connected
   to B is not pushed by A while B delivers (today's "on screen" suppression
   is client-side, so no double notification; confirm).
5. **Call registry**: either the same bus for signaling frames with call
   state in a shared table, or defer multi-instance calls (fail with
   `unavailable` when the peer is on another instance) until needed.
6. **Media**: object storage behind `mediaStorage.ts`; also solves S7.
7. **Timers**: `pg_try_advisory_lock` around the session sweep.

Nothing from this list was implemented this round on purpose: the current
single instance is at ~0 CPU and 145 MB in production, and the measured
limits are the database distance and pool, not the process.

#### F.10.6 Remaining production dependencies (nothing applied)

| Item | Who / where | Depends on |
|---|---|---|
| Deploy today's server tree (send path 2 statements, pool handler, `/health/db` pool stats, shedding, test hooks) | push to `main` → Railway auto-deploy | the user's commit/push authorization; no migration needed |
| `DB_POOL_MAX=30` (and optionally `DB_SHED_WAITING`) | Railway variables | verify the pooler's `max_client_conn` / `default_pool_size` in the Supabase dashboard first (F.10.1) |
| Region co-location | Railway service region → EU; migrate the `/data` volume | a maintenance window; the egress IP changes |
| Client release with backed-off polling and voice content keys | v0.10.0 mandatory (release recipe in section E/E0) | native rebuild of `libmls_core.so` (gitignored), signing cert |
| Media retention or object storage | server + Railway | decision on retention policy (clips are opaque to the server) |
| Multi-instance (F.10.4) | — | only after co-location and a measured need |

Rust: 33/33 unchanged (no Rust edits since). Client: 72/72 + tsc. Server:
152/152 unit, 43/43 integration, tsc clean (after the shedding change).

### F.9 Not done / honest limits

- No run above 500 connections or 200 active users; no 10k+ run of any kind.
- Client-side latencies on this Windows host are not representative (loopback
  connection retries); server-side numbers are.
- The harness's sender does not run the MLS library; ciphertext is random
  bytes, which exercises the identical server path (the server never inspects
  MLS bytes) but says nothing about client-side MLS cost per message.
