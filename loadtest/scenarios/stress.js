// Stress ramp: arrival rate climbs 25 -> 2000 req/s to find the breaking point
// (where p95 crosses the SLO or errors appear). Thresholds abort the run early.
import { loadData, mixedAction, summaryFor } from '../lib.js';

const data = loadData();
// Arrival-rate steps (req/s); override with STEPS=25,50,100 STEP_DURATION=30s.
const STEPS = (__ENV.STEPS || '25,50,100,200,400,800,1200,1600,2000').split(',').map(Number);
const STEP_DURATION = __ENV.STEP_DURATION || '20s';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: STEPS.map((target) => ({ target, duration: STEP_DURATION })),
    },
  },
  thresholds: {
    pp_read_duration: [{ threshold: 'p(95)<500', abortOnFail: false }],
    pp_unexpected_errors: [{ threshold: 'rate<0.01', abortOnFail: false }],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  mixedAction(data.users[Math.floor(Math.random() * data.users.length)]);
}

export const handleSummary = summaryFor('loadtest/results/stress.json');
