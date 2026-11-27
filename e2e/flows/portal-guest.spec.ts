/**
 * Flow: a client portal (created through the API as the seed admin) is opened
 * by an anonymous guest → they request a magic link with their email → the
 * link is read from the mail sink → opening it shows the portal's title,
 * welcome message and feedback, and the token is scrubbed from the address bar.
 */
import { expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  createAnnotation,
  createProject,
  deleteProject,
  extractLink,
  mailMarker,
  makeApiClient,
  uniqueSuffix,
  waitForMail,
} from '../browser/helpers.js';

test.describe('client portal guest access', () => {
  let api: ApiClient | null;
  let project: CreatedProject | null = null;
  let portalId: string | null = null;
  const suffix = uniqueSuffix().toLowerCase();
  const slug = `guest-${suffix}`;
  const title = `Guest Portal ${suffix}`;
  const welcome = `Welcome to the review, ${suffix}`;
  const feedbackBody = `Portal-visible feedback ${suffix}`;

  test.beforeAll(async () => {
    api = await makeApiClient();
    if (!api) return;
    project = await createProject(api, { name: `portal-flow-${suffix}`, urls: ['https://example.com/'] });
    await createAnnotation(api, project.id, 'https://example.com/', { body: feedbackBody });
    const res = await api.ctx.post('/api/v1/portals', {
      data: { projectId: project.id, title, slug, welcomeMessage: welcome, brandColor: '#2563eb' },
    });
    if (res.status() !== 201) throw new Error(`portal create failed ${res.status()} ${await res.text()}`);
    portalId = ((await res.json()) as { portal: { id: string } }).portal.id;
  });

  test.afterAll(async () => {
    if (api && portalId) await api.ctx.delete(`/api/v1/portals/${portalId}`).catch(() => {});
    if (api && project) await deleteProject(api, project).catch(() => {});
    await api?.dispose();
  });

  test('anonymous guest: request magic link → mail → open → portal renders, token scrubbed', async ({ browser }) => {
    test.skip(!api || !portalId, 'Seed session unavailable.');
    const email = `guest-${suffix}@example.test`;
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/portal/${slug}`);
      await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(welcome)).toBeVisible();
      // Not signed in yet: the access form is shown, the feedback is not.
      await expect(page.getByRole('heading', { name: 'Get your access link' })).toBeVisible();
      await expect(page.getByText(feedbackBody)).toHaveCount(0);

      const since = await mailMarker();
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByRole('button', { name: 'Email me a link' }).click();
      await expect(page.locator('[data-slot="access-sent"]')).toBeVisible();

      const mail = await waitForMail({ to: email, since, subject: /access link/i });
      const link = extractLink(mail.body, new RegExp(`^/portal/${slug}$`));
      expect(new URL(link).searchParams.get('token')).toBeTruthy();

      // Open the emailed link (path + query) in the same anonymous context.
      const url = new URL(link);
      await page.goto(`${url.pathname}${url.search}`);
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expect(page.getByText(welcome)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Feedback shared with you' })).toBeVisible();
      await expect(page.locator('[data-role="portal-feedback"]').filter({ hasText: feedbackBody })).toBeVisible();

      // The token never lingers in the address bar or history entry.
      expect(page.url()).not.toContain('token=');
      expect(new URL(page.url()).pathname).toBe(`/portal/${slug}`);
      expect(await page.evaluate(() => window.location.search)).toBe('');
    } finally {
      await ctx.close();
    }
  });
});
