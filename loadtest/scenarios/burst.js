// Create burst: N VUs hammer annotation creation with no think time. Exposes
// connection-pool starvation (a create holding a transaction connection while
// needing a second one deadlocks the pool once concurrency >= DB_POOL_MAX).
import { annotationBody, loadData, pick, send, summaryFor, writeLatency } from '../lib.js';

const data = loadData();

export const options = {
  scenarios: { burst: { executor: 'constant-vus', vus: Number(__ENV.VUS || 60), duration: __ENV.DURATION || '20s' } },
  thresholds: { pp_write_duration: ['p(95)<800'], pp_unexpected_errors: ['rate<0.01'] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const user = data.users[(__VU - 1) % data.users.length];
  const project = pick(user.projects);
  send('POST', user, `/api/v1/projects/${project.id}/annotations`, annotationBody(project), 'POST /projects/:id/annotations', writeLatency, [200, 201]);
}

export const handleSummary = summaryFor('loadtest/results/burst.json');
