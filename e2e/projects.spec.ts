/**
 * E2E project + export flow.
 *
 * Requirements covered:
 *   - 18.1, 18.4 — cookie + CSRF auth
 *   - 23.1       — creating a project with multiple URLs spawns one
 *                  Page row per unique URL
 *   - 11.3, 11.4 — CSV export emits the per-annotation browser/OS
 *                  metadata columns
 *
 * The export assertion is gated on a seeded project that contains at
 * least one annotation; the spec auto-skips when the seed isn't
 * present so `npm run test --workspace e2e` stays green on a fresh
 * stack.
 */
import { expect, test } from '@playwright/test';

import { loginExisting } from './helpers/auth.js';
import { withTemporaryProject } from './helpers/projects.js';
import {
  API_BASE_URL,
  skipIfStackDown,
} from './helpers/stack.js';

test.describe('projects + export', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('create project with multiple URLs produces one page per URL', async ({
    request,
  }) => {
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    const urls = [
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/contact',
    ];
    const name = `e2e-multi-url-${Date.now()}`;

    await withTemporaryProject(
      request,
      session,
      { name, urls },
      async (project) => {
        expect(project.id).toBeTruthy();
        // Every URL produces a Page row (Req 23.1).
        expect(project.pages).toHaveLength(urls.length);
        const pageUrls = project.pages.map((p) => p.url).sort();
        expect(pageUrls).toEqual([...urls].sort());
      },
    );
  });

  test('CSV export includes browser/OS columns', async ({ request }) => {
    const seedProjectId = process.env.FL_E2E_PROJECT_ID;
    test.skip(
      !seedProjectId,
      'Set FL_E2E_PROJECT_ID to an existing project that already has at least one annotation to assert export contents.',
    );

    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    const exportRes = await request.post(
      `${API_BASE_URL}/api/v1/projects/${seedProjectId}/export`,
      {
        headers: session.mutatingHeaders(),
        data: { format: 'csv' },
      },
    );
    expect(exportRes.status()).toBe(200);
    const csv = await exportRes.text();
    const headerLine = csv.split('\n', 1)[0];

    // Per Req 11.3 / 11.4 the browser/OS columns are present and in
    // the documented order. We assert each column header by name.
    for (const col of [
      'Browser Family',
      'Browser Version',
      'OS Family',
      'OS Version',
      'Device Type',
    ]) {
      expect(headerLine).toContain(col);
    }
  });
});
