// Public widget submissions (X-Project-Key). 429s are expected by design
// (burst + daily quota) and counted separately from real errors.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, loadData, pick, rateLimited, unexpected, widgetLatency, summaryFor } from '../lib.js';

const data = loadData();

export const options = {
  scenarios: { widget: { executor: 'constant-vus', vus: Number(__ENV.VUS || 30), duration: __ENV.DURATION || '1m' } },
  thresholds: { pp_widget_duration: ['p(95)<800'], pp_unexpected_errors: ['rate<0.01'] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  // One key per VU spreads load over projects while still hitting each key's burst limiter.
  const key = data.widgetKeys[(__VU - 1) % data.widgetKeys.length];
  const res = http.post(
    `${BASE_URL}/api/v1/widget/feedback`,
    JSON.stringify({ description: `k6 widget feedback ${Math.random()}`, severity: pick(['minor', 'major', 'informational']), pageUrl: 'https://loadtest-1-0.example.test/', viewport: { width: 1280, height: 800 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' }),
    { headers: { 'Content-Type': 'application/json', 'X-Project-Key': key.raw }, tags: { name: 'POST /widget/feedback' } },
  );
  widgetLatency.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  else {
    const ok = res.status === 201;
    unexpected.add(!ok);
    check(res, { 'widget 201': () => ok });
  }
  sleep(0.2 + Math.random() * 0.4);
}

export const handleSummary = summaryFor('loadtest/results/widget.json');
