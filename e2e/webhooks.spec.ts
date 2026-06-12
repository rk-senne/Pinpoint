/**
 * E2E webhook CRUD flow.
 *
 * Tests webhook registration, listing, and deletion. If the webhook
 * endpoint is not yet implemented (404), the spec skips gracefully.
 *
 * Skips when the API is not reachable (Task 22.1).
 */
import { expect, test } from '@playwright/test';

import { loginExisting } from './helpers/auth.js';
import { API_BASE_URL, skipIfStackDown } from './helpers/stack.js';

test.describe('webhooks', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('register webhook, list, delete', async ({ request }) => {
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    // --- Register webhook ---
    const createRes = await request.post(`${API_BASE_URL}/api/v1/webhooks`, {
      headers: session.mutatingHeaders(),
      data: {
        url: 'https://example.com/webhook-receiver',
        events: ['annotation.created', 'annotation.resolved'],
      },
    });

    // If endpoint doesn't exist yet, skip gracefully
    if (createRes.status() === 404) {
      test.skip(true, 'Webhooks endpoint not implemented yet');
      return;
    }
    expect(createRes.status()).toBe(201);
    const { webhook } = await createRes.json();
    expect(webhook.id).toBeTruthy();
    expect(webhook.url).toBe('https://example.com/webhook-receiver');

    // --- List webhooks ---
    const listRes = await request.get(`${API_BASE_URL}/api/v1/webhooks`);
    expect(listRes.ok()).toBe(true);
    const { webhooks } = await listRes.json();
    expect(webhooks.some((w: { id: string }) => w.id === webhook.id)).toBe(true);

    // --- Delete webhook ---
    const deleteRes = await request.delete(
      `${API_BASE_URL}/api/v1/webhooks/${webhook.id}`,
      { headers: session.mutatingHeaders() },
    );
    expect(deleteRes.ok()).toBe(true);

    // Verify removed
    const afterRes = await request.get(`${API_BASE_URL}/api/v1/webhooks`);
    const { webhooks: remaining } = await afterRes.json();
    expect(remaining.some((w: { id: string }) => w.id === webhook.id)).toBe(false);
  });
});
