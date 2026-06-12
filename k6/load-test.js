import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const annotationLatency = new Trend('annotation_latency');

export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up
    { duration: '2m', target: 500 },    // hold at 500 concurrent
    { duration: '30s', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],   // p95 < 200ms
    errors: ['rate<0.01'],              // <1% error rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

// Pre-register a test user and get token
export function setup() {
  const email = `k6-${Date.now()}@test.local`;
  const password = 'loadtest-password-123';

  const regRes = http.post(`${BASE_URL}/api/v1/auth/register`, JSON.stringify({
    email, password, name: 'K6 Load Test',
  }), { headers: { 'Content-Type': 'application/json' } });

  // In test env, auto-verify or skip verification
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    email, password,
  }), { headers: { 'Content-Type': 'application/json' } });

  const body = JSON.parse(loginRes.body);
  const token = body.token;

  // Create a test project
  const projectRes = http.post(`${BASE_URL}/api/v1/projects`, JSON.stringify({
    name: 'K6 Load Test Project', urls: ['https://example.com'],
  }), { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });

  const project = JSON.parse(projectRes.body);
  return { token, projectId: project.id, email };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };

  // Scenario mix: 60% reads, 30% annotation creation, 10% comments
  const roll = Math.random();

  if (roll < 0.6) {
    // GET annotations list
    const res = http.get(`${BASE_URL}/api/v1/projects/${data.projectId}/annotations`, { headers });
    check(res, { 'list 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
  } else if (roll < 0.9) {
    // POST create annotation
    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/v1/projects/${data.projectId}/annotations`, JSON.stringify({
      pageId: data.projectId,
      type: 'note',
      severity: 'minor',
      body: `Load test annotation ${Date.now()}`,
      target: { selector: '.test', xpath: '/html/body/div', coordinates: { x: 100, y: 200 } },
      environment: { url: 'https://example.com', browserFamily: 'Chrome', browserVersion: '120', osFamily: 'macOS' },
    }), { headers });
    annotationLatency.add(Date.now() - start);
    check(res, { 'create 201': (r) => r.status === 201 });
    errorRate.add(res.status !== 201);
  } else {
    // GET project analytics
    const res = http.get(`${BASE_URL}/api/v1/projects/${data.projectId}/analytics`, { headers });
    check(res, { 'analytics 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
  }

  sleep(0.1 + Math.random() * 0.4); // 100-500ms think time
}
