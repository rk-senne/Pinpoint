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
 * The export test seeds its own temporary project + annotation, so it runs on
 * a fresh stack and in CI.
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
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    // Self-seeding: a temporary project with one annotation carrying a known
    // environment, so the export's contents (not just headers) are asserted.
    await withTemporaryProject(
      request,
      session,
      { name: `e2e-export-${Date.now()}`, urls: ['https://example.com/pricing'] },
      async (project) => {
        const ann = await request.post(`${API_BASE_URL}/api/v1/projects/${project.id}/annotations`, {
          headers: session.mutatingHeaders(),
          data: {
            pageUrl: 'https://example.com/pricing',
            body: 'Export me',
            type: 'note',
            severity: 'major',
            target: { cssSelector: 'h1', xpath: '/html/body/h1', pageX: 1, pageY: 1, tagName: 'H1', textSnippet: '' },
            environment: {
              browserFamily: 'Firefox', browserVersion: '161', osFamily: 'Linux', osVersion: '6',
              deviceType: 'desktop', userAgentRaw: 'Mozilla/5.0 (X11; Linux x86_64; rv:161.0) Gecko/20100101 Firefox/161.0',
            },
          },
        });
        expect(ann.status()).toBe(201);

        const exportRes = await request.post(`${API_BASE_URL}/api/v1/projects/${project.id}/export`, {
          headers: session.mutatingHeaders(),
          data: { format: 'csv' },
        });
        expect(exportRes.status()).toBe(200);
        const csv = await exportRes.text();
        const [headerLine, ...rows] = csv.trim().split('\n');

        // Per Req 11.3 / 11.4 the browser/OS columns are present.
        for (const col of ['Browser Family', 'Browser Version', 'OS Family', 'OS Version', 'Device Type']) {
          expect(headerLine).toContain(col);
        }
        const row = rows.find((r) => r.includes('Export me'));
        expect(row, 'the annotation is exported').toBeTruthy();
        expect(row).toContain('Firefox');
        expect(row).toContain('161');
        expect(row).toContain('Linux');
      },
    );
  });
});
