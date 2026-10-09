#!/usr/bin/env node
// TCP proxy that adds a fixed one-way delay in each direction, to reproduce
// a far-away database locally. Production runs the API on Railway (us-west)
// against Supabase in eu-west-1, roughly 140-160 ms round trip; a local
// Postgres answers in well under a millisecond, which hides every
// connection-pool and query-count problem. Point a test server's
// DATABASE_URL at this proxy instead of the database.
//
// Usage: node scripts/loadtest/latency-proxy.mjs --listen 15433 --target 127.0.0.1:15432 --delay 75
//   (75 ms each way = 150 ms round trip)
import net from 'node:net';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LISTEN = Number(arg('listen', 15433));
const [targetHost, targetPort] = String(arg('target', '127.0.0.1:15432')).split(':');
const DELAY = Number(arg('delay', 75));

let connections = 0;
const server = net.createServer((client) => {
  connections++;
  const upstream = net.connect({ host: targetHost, port: Number(targetPort) });
  const pipeDelayed = (from, to) => {
    from.on('data', (chunk) => {
      from.pause();
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
        from.resume();
      }, DELAY);
    });
    from.on('end', () => setTimeout(() => to.end(), DELAY));
    from.on('error', () => to.destroy());
    from.on('close', () => {
      if (from === client) connections--;
    });
  };
  pipeDelayed(client, upstream);
  pipeDelayed(upstream, client);
});
server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`latency proxy 127.0.0.1:${LISTEN} -> ${targetHost}:${targetPort}, ${DELAY} ms each way`);
});
setInterval(() => console.log(`${new Date().toISOString()} connections=${connections}`), 30000).unref();
