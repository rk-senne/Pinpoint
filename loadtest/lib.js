// Shared helpers for the k6 scenarios. Tokens/keys come from loadtest/.tokens.json
// (written by `node loadtest/seed.mts`) or, in CI, from setup() via the API.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

export const readLatency = new Trend('pp_read_duration', true);
export const writeLatency = new Trend('pp_write_duration', true);
export const widgetLatency = new Trend('pp_widget_duration', true);
// "Unexpected" = anything that is not a 2xx/expected status (429 is counted separately).
export const unexpected = new Rate('pp_unexpected_errors');
export const rateLimited = new Counter('pp_rate_limited_429');

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    s += i === 8 || i === 13 || i === 18 || i === 23 ? '-' : i === 14 ? '4' : i === 19 ? '89ab'[Math.floor(Math.random() * 4)] : h[Math.floor(Math.random() * 16)];
  }
  return s;
}

function headers(user) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` } };
}

function record(trend, res, okStatuses, name) {
  trend.add(res.timings.duration, { name });
  if (res.status === 429) {
    rateLimited.add(1);
    return;
  }
  const ok = okStatuses.includes(res.status);
  unexpected.add(!ok);
  if (!ok && __ENV.DEBUG_FAIL) console.warn(`${name} -> ${res.status} ${String(res.body).slice(0, 160)}`);
  check(res, { [`${name} status`]: () => ok });
}

export function get(user, path, name) {
  const res = http.get(`${BASE_URL}${path}`, { ...headers(user), tags: { name } });
  record(readLatency, res, [200], name);
  return res;
}

export function send(method, user, path, body, name, trend, ok) {
  const res = http.request(method, `${BASE_URL}${path}`, JSON.stringify(body), { ...headers(user), tags: { name } });
  record(trend || writeLatency, res, ok || [200, 201], name);
  return res;
}

const TYPES = ['note', 'suggestion', 'guideline'];
const SEVERITIES = ['critical', 'major', 'minor', 'informational'];

export function annotationBody(project) {
  return {
    type: pick(TYPES),
    severity: pick(SEVERITIES),
    body: `k6 loadtest annotation ${uuid()}`,
    pageUrl: project.pageUrl,
    clientRequestId: uuid(),
    target: { cssSelector: 'div.card > button', xpath: '/html/body/div/button', pageX: Math.floor(Math.random() * 1200), pageY: Math.floor(Math.random() * 3000), tagName: 'BUTTON', textSnippet: 'Buy now' },
    environment: { browserFamily: 'Chrome', browserVersion: '120.0', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'k6', viewportWidth: 1280, viewportHeight: 800 },
  };
}

/** Load users/keys: from the seeded token file (local) or `TOKENS_JSON` env path. */
export function loadData() {
  return JSON.parse(open(__ENV.TOKENS_FILE || import.meta.resolve('./.tokens.json')));
}

export const READ_SCENARIO = {
  list_projects: (u) => get(u, '/api/v1/projects', 'GET /projects'),
  list_annotations: (u, p) => get(u, `/api/v1/projects/${p.id}/annotations?page=${1 + Math.floor(Math.random() * 3)}&pageSize=25`, 'GET /projects/:id/annotations'),
  list_annotations_status: (u, p) => get(u, `/api/v1/projects/${p.id}/annotations?status=${pick(['active', 'in_progress', 'resolved'])}&pageSize=50`, 'GET /projects/:id/annotations?status'),
  analytics: (u, p) => get(u, `/api/v1/projects/${p.id}/analytics`, 'GET /projects/:id/analytics'),
  heatmap: (u, p) => get(u, `/api/v1/projects/${p.id}/heatmap?pageUrl=${encodeURIComponent(p.pageUrl)}`, 'GET /projects/:id/heatmap'),
  comments: (u, p) => get(u, `/api/v1/annotations/${Math.random() < 0.3 ? p.annotationId : pick(p.annotationIds)}/comments`, 'GET /annotations/:id/comments'),
  annotation: (u, p) => get(u, `/api/v1/annotations/${p.annotationId}`, 'GET /annotations/:id'),
};

/** One mixed-workload action (~80% reads / ~20% writes) for the given user. */
export function mixedAction(user) {
  const project = pick(user.projects);
  const roll = Math.random();
  if (roll < 0.15) READ_SCENARIO.list_projects(user);
  else if (roll < 0.35) READ_SCENARIO.list_annotations(user, project);
  else if (roll < 0.5) READ_SCENARIO.list_annotations_status(user, project);
  else if (roll < 0.6) READ_SCENARIO.analytics(user, project);
  else if (roll < 0.68) READ_SCENARIO.heatmap(user, project);
  else if (roll < 0.76) READ_SCENARIO.comments(user, project);
  else if (roll < 0.8) READ_SCENARIO.annotation(user, project);
  else if (roll < 0.9) {
    send('POST', user, `/api/v1/projects/${project.id}/annotations`, annotationBody(project), 'POST /projects/:id/annotations', writeLatency, [200, 201]);
  } else if (roll < 0.96) {
    send('POST', user, `/api/v1/annotations/${pick(project.annotationIds)}/comments`, { body: `k6 comment ${uuid()}`, clientRequestId: uuid() }, 'POST /annotations/:id/comments', writeLatency, [200, 201]);
  } else {
    send('PUT', user, `/api/v1/annotations/${pick(project.annotationIds)}/status`, { status: pick(['active', 'in_progress', 'resolved']) }, 'PUT /annotations/:id/status', writeLatency, [200]);
  }
}

// Targets from the task: reads p95 < 500 ms, writes p95 < 800 ms, < 1 % unexpected errors
// (429s excluded). CI smoke runs on a shared 2-vCPU runner and loosens them via env.
export const THRESHOLDS = {
  pp_read_duration: [`p(95)<${__ENV.READ_P95_MS || 500}`],
  pp_write_duration: [`p(95)<${__ENV.WRITE_P95_MS || 800}`],
  pp_unexpected_errors: [`rate<${__ENV.MAX_ERROR_RATE || 0.01}`],
};

export function summaryFor(file) {
  return function handleSummary(d) {
    const m = d.metrics;
    const f = (k, s) => (m[k] && m[k].values[s] !== undefined ? m[k].values[s].toFixed(1) : 'n/a');
    const text = [
      `reqs=${m.http_reqs.values.count} rps=${m.http_reqs.values.rate.toFixed(1)} vus_max=${m.vus_max ? m.vus_max.values.max : 'n/a'}`,
      `read p50=${f('pp_read_duration', 'med')} p95=${f('pp_read_duration', 'p(95)')} p99=${f('pp_read_duration', 'p(99)')}ms | write p50=${f('pp_write_duration', 'med')} p95=${f('pp_write_duration', 'p(95)')} p99=${f('pp_write_duration', 'p(99)')}ms`,
      `unexpected-error rate=${(m.pp_unexpected_errors ? m.pp_unexpected_errors.values.rate * 100 : 0).toFixed(2)}% 429s=${m.pp_rate_limited_429 ? m.pp_rate_limited_429.values.count : 0} dropped_iterations=${m.dropped_iterations ? m.dropped_iterations.values.count : 0}`,
      '',
    ].join('\n');
    return { [__ENV.SUMMARY_FILE || file]: JSON.stringify(d, null, 1), stdout: text };
  };
}
