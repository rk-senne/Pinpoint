// Realtime fan-out load test: LISTENERS socket.io clients join project rooms on
// the /collab namespace; PRODUCERS create annotations over HTTP; we measure the
// delay from "request sent" to "annotation.created received" per listener.
//
//   node loadtest/realtime.mjs                       # defaults: 200 listeners in 5 rooms, 5 creates/s, 60 s
//   LISTENERS=500 DURATION=120 RATE=10 node loadtest/realtime.mjs
//
// Env: BASE_URL (default http://127.0.0.1:3001), LISTENERS (200), DURATION s (60),
//      ROOMS (5), RATE creates/s (5), P95_MS threshold (500), OUT results file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const LISTENERS = Number(process.env.LISTENERS || 200);
const DURATION = Number(process.env.DURATION || 60);
const RATE = Number(process.env.RATE || 5);
const P95_MS = Number(process.env.P95_MS || 500);
const OUT = process.env.OUT || join(HERE, 'results', 'realtime.json');
const data = JSON.parse(readFileSync(process.env.TOKENS_FILE || join(HERE, '.tokens.json'), 'utf8'));

const sentAt = new Map(); // marker -> performance.now() at request start
const delays = [];
let expected = 0;
let received = 0;
let connectFailures = 0;
let httpErrors = 0;

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Each listener sits in one project room owned by its user (room access = owner or team member).
// ROOMS rooms (default 5) share the listeners, so each created annotation fans out to LISTENERS/ROOMS sockets.
const ROOMS = Math.min(Number(process.env.ROOMS || 5), data.users.length);
const targets = [];
for (let i = 0; i < LISTENERS; i++) {
  const user = data.users[i % ROOMS];
  targets.push({ user, project: user.projects[0] });
}
const roomListeners = new Map(); // projectId -> number of listeners
const sockets = [];

async function connectAll() {
  await Promise.all(
    targets.map(
      ({ user, project }) =>
        new Promise((resolve) => {
          const socket = io(`${BASE}/collab`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, timeout: 10_000 });
          const done = (ok) => { if (!ok) connectFailures++; resolve(); };
          socket.on('connect_error', () => done(false));
          socket.on('connect', () => {
            socket.emit('join', { projectId: project.id });
            roomListeners.set(project.id, (roomListeners.get(project.id) || 0) + 1);
            setTimeout(() => done(true), 150); // let the join be authorised
          });
          socket.on('annotation.created', (payload) => {
            const t = sentAt.get(String(payload?.body ?? '').trim());
            if (t === undefined) return;
            received++;
            delays.push(performance.now() - t);
          });
          sockets.push(socket);
        }),
    ),
  );
}

async function produce() {
  const end = Date.now() + DURATION * 1000;
  const interval = 1000 / RATE;
  let n = 0;
  const inflight = [];
  while (Date.now() < end) {
    const started = Date.now();
    const { user, project } = targets[n % ROOMS]; // first ROOMS targets are distinct rooms
    const marker = `rt-${process.pid}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
    expected += roomListeners.get(project.id) || 0;
    sentAt.set(marker, performance.now());
    inflight.push(
      fetch(`${BASE}/api/v1/projects/${project.id}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
        body: JSON.stringify({
          type: 'note', severity: 'minor', body: marker, pageUrl: project.pageUrl,
          target: { cssSelector: 'body', xpath: '/html/body', pageX: 1, pageY: 1, tagName: 'BODY', textSnippet: 'rt' },
          environment: { browserFamily: 'Chrome', browserVersion: '120', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'realtime' },
        }),
      }).then((r) => { if (r.status !== 201) httpErrors++; return r.arrayBuffer(); }).catch(() => { httpErrors++; }),
    );
    const wait = interval - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await Promise.all(inflight);
  await new Promise((r) => setTimeout(r, 3000)); // drain late deliveries
}

await connectAll();
console.log(`connected ${sockets.length - connectFailures}/${LISTENERS} listeners across ${roomListeners.size} rooms; producing ${RATE}/s for ${DURATION}s`);
await produce();
for (const s of sockets) s.close();

const result = {
  listeners: LISTENERS, connectFailures, rooms: roomListeners.size, ratePerSec: RATE, durationSec: DURATION,
  expectedDeliveries: expected, received, lossPct: expected ? +(100 * (1 - received / expected)).toFixed(2) : 0, httpErrors,
  delayMs: { p50: +pct(delays, 50).toFixed(1), p95: +pct(delays, 95).toFixed(1), p99: +pct(delays, 99).toFixed(1), max: +Math.max(...delays).toFixed(1) },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
const ok = result.delayMs.p95 < P95_MS && result.lossPct < 1 && connectFailures === 0 && httpErrors === 0;
console.log(ok ? `PASS (p95 ${result.delayMs.p95} ms < ${P95_MS} ms)` : 'FAIL');
process.exit(ok ? 0 : 1);
