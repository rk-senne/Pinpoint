// Realistic mixed workload: ~80% reads / ~20% writes against seeded data.
// Default: 50 virtual users, each ~1 req / 5 s (=> ~10 rps), 3 minutes.
import { sleep } from 'k6';
import { loadData, mixedAction, summaryFor, THRESHOLDS } from '../lib.js';

const data = loadData();
const THINK = Number(__ENV.THINK_SECONDS || 5);

export const options = {
  scenarios: { baseline: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '3m' } },
  thresholds: THRESHOLDS,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  mixedAction(data.users[(__VU - 1) % data.users.length]);
  sleep(THINK * (0.5 + Math.random()));
}

export const handleSummary = summaryFor('loadtest/results/mixed.json');
