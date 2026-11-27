// Soak: moderate steady load (default 10 minutes, 25 rps). Pair with
// `node loadtest/soak-monitor.mjs` to sample API RSS / heap from /metrics.
import { loadData, mixedAction, summaryFor, THRESHOLDS } from '../lib.js';

const data = loadData();
// ORGS=1 pins all traffic to one tenant (measures the RLS context-switch cost: users come in pairs per org).
const users = __ENV.ORGS ? data.users.slice(0, Number(__ENV.ORGS) * 2) : data.users;

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RPS || 25),
      timeUnit: '1s',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: THRESHOLDS,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  mixedAction(users[Math.floor(Math.random() * users.length)]);
}

export const handleSummary = summaryFor('loadtest/results/soak.json');
