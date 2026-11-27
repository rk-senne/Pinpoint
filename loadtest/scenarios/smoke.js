// ~2 minute smoke for CI: a light mixed workload, then a create burst (guards the
// connection-pool starvation regression) and a widget burst. Thresholds are
// overridable via env (READ_P95_MS / WRITE_P95_MS / MAX_ERROR_RATE) because
// shared CI runners are slower than the dev box the SLOs were measured on.
import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  annotationBody, BASE_URL, loadData, mixedAction, pick, rateLimited, send, summaryFor, THRESHOLDS,
  unexpected, widgetLatency, writeLatency,
} from '../lib.js';

const data = loadData();

export const options = {
  scenarios: {
    mixed: { executor: 'constant-vus', exec: 'mixed', vus: 10, duration: '60s' },
    burst: { executor: 'constant-vus', exec: 'burst', vus: 30, duration: '15s', startTime: '60s' },
    widget: { executor: 'constant-vus', exec: 'widget', vus: 10, duration: '15s', startTime: '80s' },
  },
  thresholds: { ...THRESHOLDS, pp_widget_duration: [`p(95)<${__ENV.WRITE_P95_MS || 800}`] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function mixed() {
  mixedAction(data.users[(__VU - 1) % data.users.length]);
  sleep(0.5 + Math.random());
}

export function burst() {
  const user = data.users[(__VU - 1) % data.users.length];
  const project = pick(user.projects);
  send('POST', user, `/api/v1/projects/${project.id}/annotations`, annotationBody(project), 'POST /projects/:id/annotations', writeLatency, [200, 201]);
}

export function widget() {
  const key = data.widgetKeys[(__VU - 1) % data.widgetKeys.length];
  const res = http.post(
    `${BASE_URL}/api/v1/widget/feedback`,
    JSON.stringify({ description: `k6 smoke widget ${Math.random()}`, pageUrl: 'https://loadtest-1-0.example.test/', viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36' }),
    { headers: { 'Content-Type': 'application/json', 'X-Project-Key': key.raw }, tags: { name: 'POST /widget/feedback' } },
  );
  widgetLatency.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  else {
    const ok = res.status === 201;
    unexpected.add(!ok);
    check(res, { 'widget 201': () => ok });
  }
  sleep(0.2);
}

export const handleSummary = summaryFor('loadtest/results/smoke.json');
