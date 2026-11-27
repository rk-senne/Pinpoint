// Write scenario: annotation create, comment create, status change (50 VUs).
import { sleep } from 'k6';
import { annotationBody, loadData, pick, send, summaryFor, THRESHOLDS, uuid, writeLatency } from '../lib.js';

const data = loadData();

export const options = {
  scenarios: { writes: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '2m' } },
  thresholds: { pp_write_duration: THRESHOLDS.pp_write_duration, pp_unexpected_errors: THRESHOLDS.pp_unexpected_errors },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const user = data.users[(__VU - 1) % data.users.length];
  const project = pick(user.projects);
  const roll = Math.random();
  if (roll < 0.5) {
    send('POST', user, `/api/v1/projects/${project.id}/annotations`, annotationBody(project), 'POST /projects/:id/annotations', writeLatency, [200, 201]);
  } else if (roll < 0.85) {
    send('POST', user, `/api/v1/annotations/${pick(project.annotationIds)}/comments`, { body: `k6 comment ${uuid()}`, clientRequestId: uuid() }, 'POST /annotations/:id/comments', writeLatency, [200, 201]);
  } else {
    send('PUT', user, `/api/v1/annotations/${pick(project.annotationIds)}/status`, { status: pick(['active', 'in_progress', 'resolved']) }, 'PUT /annotations/:id/status', writeLatency, [200]);
  }
  sleep(Number(__ENV.THINK_SECONDS || 1) * (0.5 + Math.random()));
}

export const handleSummary = summaryFor('loadtest/results/writes.json');
