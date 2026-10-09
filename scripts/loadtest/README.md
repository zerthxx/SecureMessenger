# Load and failure harness

Local or dedicated test servers only. The scripts register throwaway
accounts and send random bytes as "ciphertext"; `run.mjs` refuses hosts that
look like production. Measured results and the capacity model live in
`docs/ENGINEERING_CHECKLIST.md`, section F.

## Setup

1. A disposable Postgres with the schema applied (the integration-test
   container works: `postgres://test:test@127.0.0.1:15432/sm_test`).
2. A dedicated server, never the dev server the apps use:

   ```sh
   cd server
   PORT=4100 DATABASE_URL=postgres://test:test@127.0.0.1:15432/sm_test \
   TRUST_PROXY=loopback LOG_LEVEL=info npx tsx src/index.ts
   ```

   `TRUST_PROXY=loopback` lets the harness present a different
   `X-Forwarded-For` per virtual user, so per-IP limits behave as with real
   phones. `LOG_LEVEL=info` gives per-request `responseTime` lines; the
   server-side percentiles from that log are the trustworthy numbers (the
   client-side ones include the load generator's own connection effects).

3. To reproduce the production topology (API far from the database):

   ```sh
   node scripts/loadtest/latency-proxy.mjs --listen 15433 --target 127.0.0.1:15432 --delay 75
   # then start a server with DATABASE_URL=postgres://test:test@127.0.0.1:15433/sm_test
   ```

## Runs

```sh
node scripts/loadtest/run.mjs --base http://127.0.0.1:4100 --users 50 --duration 60 --rate 6 --fetch-every 1
node scripts/loadtest/run.mjs --base http://127.0.0.1:4100 --users 500 --duration 60 --sockets-only
```

Options: `--users N`, `--duration s`, `--rate` messages per user per minute,
`--fetch-every n` (receivers fetch after every n-th realtime hint; 0 = only at
the end), `--sockets-only` (hold idle authenticated sockets for memory
measurements), `--setup-concurrency` (default 10), `--timeout ms`.

Output: a JSON summary on stdout and in `results/<timestamp>.json` with send
and hint latencies (p50/p95/p99/max), errors by message, socket drops and
reconnects, and per-conversation duplicates / per-sender ordering / missing
rows as seen by the receivers' own fetches. No tokens or secrets are written.

Sample `GET /health/db` every 10 s during a run for `pool.waiting`: above 0
means requests are queueing for a database connection.

## Failure scenarios used so far

- Database unreachable mid-run: kill the latency proxy, restart it 15 s later.
- Server restart with sockets held: kill the server process during a
  `--sockets-only` run and start it again.
- Pool exhaustion: `DB_POOL_MAX=10` behind the proxy with 200 users.
- Realtime down (app-side poll behaviour): start the dev server with
  `E2EE_TEST_REALTIME_DOWN=1` (development only; no-op in production).
