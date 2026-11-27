// Read-only scenario: every read endpoint, per-endpoint latency via the `name` tag.
import { sleep } from 'k6';
import { loadData, pick, READ_SCENARIO, summaryFor, THRESHOLDS } from '../lib.js';

const data = loadData();
const ENDPOINTS = Object.keys(READ_SCENARIO);

export const options = {
  scenarios: { reads: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '2m' } },
  thresholds: { pp_read_duration: THRESHOLDS.pp_read_duration, pp_unexpected_errors: THRESHOLDS.pp_unexpected_errors },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const user = data.users[(__VU - 1) % data.users.length];
  READ_SCENARIO[pick(ENDPOINTS)](user, pick(user.projects));
  sleep(Number(__ENV.THINK_SECONDS || 1) * (0.5 + Math.random()));
}

export const handleSummary = summaryFor('loadtest/results/reads.json');
