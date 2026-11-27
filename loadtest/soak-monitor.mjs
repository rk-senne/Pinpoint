// Samples API process memory from GET /metrics while a soak run is in progress.
//   node loadtest/soak-monitor.mjs                  # 10 min, every 10 s
//   DURATION=300 INTERVAL=5 METRICS_TOKEN=... node loadtest/soak-monitor.mjs
// Unauthenticated loopback access works when METRICS_TOKEN is unset on the API.
// Exit code 1 when RSS grew by more than MAX_GROWTH_PCT (default 50 %) between the
// first minute's average and the last minute's average (leak heuristic).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';
const DURATION = Number(process.env.DURATION || 600);
const INTERVAL = Number(process.env.INTERVAL || 10);
const MAX_GROWTH_PCT = Number(process.env.MAX_GROWTH_PCT || 50);
const OUT = process.env.OUT || join(HERE, 'results', 'soak-memory.json');
const headers = process.env.METRICS_TOKEN ? { authorization: `Bearer ${process.env.METRICS_TOKEN}` } : {};

function metric(text, name) {
  const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)$`, 'm'));
  return m ? Number(m[1]) : NaN;
}

const samples = [];
const end = Date.now() + DURATION * 1000;
while (Date.now() < end) {
  try {
    const text = await (await fetch(`${BASE}/metrics`, { headers })).text();
    samples.push({
      t: Math.round((Date.now() - (end - DURATION * 1000)) / 1000),
      rssMB: +(metric(text, 'process_resident_memory_bytes') / 1048576).toFixed(1),
      heapUsedMB: +(metric(text, 'nodejs_heap_size_used_bytes') / 1048576).toFixed(1),
      eventLoopLagP99Ms: +(metric(text, 'nodejs_eventloop_lag_p99_seconds') * 1000).toFixed(2),
      openFds: metric(text, 'process_open_fds'),
    });
  } catch (e) {
    samples.push({ t: -1, error: String(e) });
  }
  await new Promise((r) => setTimeout(r, INTERVAL * 1000));
}

const ok = samples.filter((s) => s.rssMB > 0);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const per = Math.max(1, Math.round(60 / INTERVAL));
const first = avg(ok.slice(0, per).map((s) => s.rssMB));
const last = avg(ok.slice(-per).map((s) => s.rssMB));
const summary = {
  samples: ok.length,
  rssMB: { first: +first.toFixed(1), last: +last.toFixed(1), max: Math.max(...ok.map((s) => s.rssMB)) },
  heapUsedMB: { first: ok[0]?.heapUsedMB, last: ok.at(-1)?.heapUsedMB, max: Math.max(...ok.map((s) => s.heapUsedMB)) },
  rssGrowthPct: +(((last - first) / first) * 100).toFixed(1),
  eventLoopLagP99MsMax: Math.max(...ok.map((s) => s.eventLoopLagP99Ms)),
  openFdsLast: ok.at(-1)?.openFds,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ summary, samples }, null, 1));
console.log(JSON.stringify(summary));
process.exit(summary.rssGrowthPct > MAX_GROWTH_PCT ? 1 : 0);
