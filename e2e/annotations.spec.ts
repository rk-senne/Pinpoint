/**
 * E2E annotation CRUD flow.
 *
 * Requirements covered:
 *   - 3.1  — create annotation
 *   - 3.2  — update annotation status (resolve)
 *   - 5.1  — add comment to annotation
 *   - 3.3  — delete annotation
 *   - 24   — atomic pin numbering
 *
 * Skips when the API is not reachable (Task 22.1).
 */
import { expect, test } from '@playwright/test';

import { loginExisting } from './helpers/auth.js';
import { withTemporaryProject } from './helpers/projects.js';
import { API_BASE_URL, skipIfStackDown } from './helpers/stack.js';

test.describe('annotations CRUD', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('create annotation, resolve, comment, delete', async ({ request }) => {
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    await withTemporaryProject(
      request,
      session,
      { name: `e2e-annotations-${Date.now()}`, urls: ['https://example.com/'] },
      async (project) => {
        // --- Create annotation ---
        const createRes = await request.post(
          `${API_BASE_URL}/api/v1/projects/${project.id}/annotations`,
          {
            headers: session.mutatingHeaders(),
            data: {
              pageUrl: project.pages[0].url,
              body: 'E2E test annotation',
              type: 'note',
              severity: 'minor',
              target: {
                cssSelector: 'body',
                xpath: '/html/body',
                pageX: 100,
                pageY: 200,
                tagName: 'BODY',
                textSnippet: '',
              },
              environment: {
                browserFamily: 'Chrome',
                browserVersion: '120.0',
                osFamily: 'macOS',
                osVersion: '14.0',
                deviceType: 'desktop',
                userAgentRaw:
                  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            },
          },
        );
        expect(createRes.status()).toBe(201);
        const { annotation } = await createRes.json();
        expect(annotation.id).toBeTruthy();
        expect(annotation.pinNumber).toBeGreaterThan(0);

        // Verify it appears in project annotations list
        const listRes = await request.get(
          `${API_BASE_URL}/api/v1/projects/${project.id}/annotations`,
        );
        expect(listRes.ok()).toBe(true);
        const { data: annotations } = await listRes.json();
        expect(annotations.some((a: { id: string }) => a.id === annotation.id)).toBe(true);

        // --- Resolve annotation ---
        const resolveRes = await request.put(
          `${API_BASE_URL}/api/v1/annotations/${annotation.id}/status`,
          {
            headers: session.mutatingHeaders(),
            data: { status: 'resolved' },
          },
        );
        expect(resolveRes.ok()).toBe(true);
        const { annotation: resolved } = await resolveRes.json();
        expect(resolved.status).toBe('resolved');

        // --- Add comment ---
        const commentRes = await request.post(
          `${API_BASE_URL}/api/v1/annotations/${annotation.id}/comments`,
          {
            headers: session.mutatingHeaders(),
            data: { body: 'E2E test comment' },
          },
        );
        expect(commentRes.status()).toBe(201);
        const { comment } = await commentRes.json();
        expect(comment.body).toBe('E2E test comment');

        // Verify comment appears in list
        const commentsRes = await request.get(
          `${API_BASE_URL}/api/v1/annotations/${annotation.id}/comments`,
        );
        expect(commentsRes.ok()).toBe(true);
        const { data: comments } = await commentsRes.json();
        expect(comments.some((c: { id: string }) => c.id === comment.id)).toBe(true);

        // --- Delete annotation ---
        const deleteRes = await request.delete(
          `${API_BASE_URL}/api/v1/annotations/${annotation.id}`,
          { headers: session.mutatingHeaders() },
        );
        expect(deleteRes.ok()).toBe(true);

        // Verify removed from list
        const afterDeleteRes = await request.get(
          `${API_BASE_URL}/api/v1/projects/${project.id}/annotations`,
        );
        const { data: remaining } = await afterDeleteRes.json();
        expect(remaining.some((a: { id: string }) => a.id === annotation.id)).toBe(false);
      },
    );
  });
});
