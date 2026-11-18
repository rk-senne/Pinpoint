/**
 * UI audit — every dashboard route, desktop + mobile, with an axe scan.
 *
 * Seeds a realistic demo workspace ("Acme Marketing Site", annotations of
 * mixed severity/status/type, comments, a guest submission, a team with a
 * second member, an unread @mention), logs in through the real form ONCE,
 * then walks every route at 1440x900 and 390x844:
 *   • full-page screenshot → docs/screenshots/<route>-<desktop|mobile>.png
 *     (written only by the Chromium project so Firefox/WebKit runs don't
 *     churn the committed images),
 *   • axe-core scan; critical/serious violations are collected into one
 *     table (printed + asserted empty in the final test),
 *   • horizontal-overflow check on mobile and a scan for raw
 *     "undefined" / "NaN" / "[object Object]" text.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';

import {
  ACME_ANNOTATIONS,
  DEMO_PASSWORD,
  type DemoUser,
  acceptAndSwitch,
  addComment,
  createDemoAnnotation,
  demoReplayEvents,
  ensureUser,
  inviteWithKnownToken,
  sql,
} from './demo.js';
import { API_URL } from './helpers.js';

const SHOT_DIR = resolve(process.cwd(), '..', 'docs', 'screenshots');
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

interface Finding {
  route: string;
  viewport: string;
  rule: string;
  impact: string;
  nodes: number;
  sample: string;
}
const findings: Finding[] = [];
const layoutIssues: string[] = [];
const details: unknown[] = [];
const consoleIssues: string[] = [];

const ACME_URL = 'https://example.com';

test.setTimeout(120_000);

test.describe('dashboard UI audit', () => {
  let maya: DemoUser;
  let daniel: DemoUser;
  let projectId = '';
  let sharedLinkId = '';
  let protectedLinkId = '';
  let inviteToken = '';
  let authed: BrowserContext;
  let anon: BrowserContext;
  const writeShots = (name: string) => name === 'browser';

  test.beforeAll(async ({ browser }, info) => {
    test.setTimeout(240_000);
    mkdirSync(SHOT_DIR, { recursive: true });
    maya = await ensureUser({ email: 'maya.chen@acmestudio.dev', name: 'Maya Chen', pro: true });
    daniel = await ensureUser({ email: 'daniel.okafor@acmestudio.dev', name: 'Daniel Okafor' });

    // Clean slate for the demo org so re-runs do not accumulate data.
    const existing = await maya.ctx.get('/api/v1/projects');
    const list = (await existing.json()) as { data?: Array<{ id: string; name: string }> };
    for (const p of list.data ?? []) {
      await maya.ctx.delete(`/api/v1/projects/${p.id}`, { data: { confirmationToken: p.name } });
    }

    // Daniel joins Maya's org (known token minted via the DB).
    const orgMember = sql(
      `select count(*) from memberships where user_id='${daniel.userId}' and org_id='${maya.orgId}'`,
    );
    let danielCtx = daniel.ctx;
    if (orgMember === '0') {
      const raw = await inviteWithKnownToken(maya, daniel.email, 'member');
      danielCtx = await acceptAndSwitch(daniel, raw, maya.orgId);
    } else {
      const sw = await daniel.ctx.post('/api/v1/org/switch', { data: { orgId: maya.orgId } });
      const { token } = (await sw.json()) as { token: string };
      const { request } = await import('@playwright/test');
      danielCtx = await request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    }

    // Team with a member (drop teams/guidelines from earlier runs first).
    sql(`delete from teams where owner_id = '${maya.userId}'`);
    sql(`delete from guidelines where created_by_user_id = '${maya.userId}'`);
    const team = await maya.ctx.post('/api/v1/teams', { data: { name: 'Design & QA' } });
    const teamId = ((await team.json()) as { team: { id: string } }).team.id;
    await maya.ctx.post(`/api/v1/teams/${teamId}/invite`, { data: { email: daniel.email } });

    const created = await maya.ctx.post('/api/v1/projects', {
      data: { name: 'Acme Marketing Site', teamId, urls: [`${ACME_URL}/`, `${ACME_URL}/pricing`, `${ACME_URL}/blog`] },
    });
    expect(created.status()).toBe(201);
    projectId = ((await created.json()) as { project: { id: string } }).project.id;

    const ids: string[] = [];
    for (const [i, spec] of ACME_ANNOTATIONS.entries()) {
      const a = await createDemoAnnotation(
        maya.ctx,
        projectId,
        ACME_URL,
        i === 0 ? { ...spec, sessionReplay: demoReplayEvents() } : spec,
      );
      ids.push(a.id);
    }
    await addComment(maya.ctx, ids[1]!, 'Reproduced on an iPhone 14. The Stripe element never mounts after the address step.');
    await addComment(danielCtx, ids[1]!, `@Maya Chen I can see the 422 in the logs, looks like the payment intent is created without a customer. Taking this one.`, [maya.userId]);
    await addComment(maya.ctx, ids[0]!, 'Design suggests clamping the headline to two lines with a smaller max font size.');
    await danielCtx.put(`/api/v1/annotations/${ids[1]}`, { data: { assigneeId: daniel.userId, dueDate: '2026-11-20T00:00:00.000Z' } });

    // Custom guideline.
    await maya.ctx.post('/api/v1/guidelines', {
      data: { name: 'Brand voice', description: 'Headlines are sentence case, no exclamation marks, max 8 words.' },
    });

    // Shared links: one open (guest feedback), one password-protected.
    const share = await maya.ctx.post(`/api/v1/projects/${projectId}/share`, { data: { allowFeedback: true } });
    sharedLinkId = ((await share.json()) as { sharedLink: { id: string } }).sharedLink.id;
    const guest = await (await import('@playwright/test')).request.newContext({ baseURL: API_URL });
    const g = await guest.post(`/api/v1/shared/${sharedLinkId}/feedback`, {
      data: {
        name: 'Priya Nair',
        email: 'priya.nair@northwind.example',
        description: 'The testimonials carousel jumps back to the first slide whenever I scroll past it.',
        pageUrl: `${ACME_URL}/`,
        severity: 'minor',
      },
    });
    expect(g.status()).toBe(201);
    await guest.dispose();

    const p2 = await maya.ctx.post('/api/v1/projects', {
      data: { name: 'Northwind Client Portal', urls: [`${ACME_URL}/portal`] },
    });
    const p2Id = ((await p2.json()) as { project: { id: string } }).project.id;
    const share2 = await maya.ctx.post(`/api/v1/projects/${p2Id}/share`, { data: { allowFeedback: true, password: 'Review-2026!' } });
    protectedLinkId = ((await share2.json()) as { sharedLink: { id: string } }).sharedLink.id;

    // A pending invitation for the accept page.
    inviteToken = await inviteWithKnownToken(maya, 'jordan.reyes@acmestudio.dev', 'member');

    // One real UI login (fresh cookie jar).
    authed = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await authed.newPage();
    await page.goto('/auth');
    await page.locator('input[name="email"]').fill(maya.email);
    await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
    await page.close();
    anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    void info;
  });

  test.afterAll(async () => {
    await authed?.close();
    await anon?.close();
  });

  async function audit(
    ctx: BrowserContext,
    name: string,
    path: string,
    ready: (page: Page) => Promise<void>,
    prepare?: (page: Page) => Promise<void>,
  ): Promise<void> {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => consoleIssues.push(`${name}: pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) {
        consoleIssues.push(`${name}: console.error ${m.text().slice(0, 160)}`);
      }
    });
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(vp);
      await page.goto(path);
      await ready(page);
      if (prepare) await prepare(page);
      await page.waitForTimeout(400); // let transitions / toasts settle
      if (writeShots(test.info().project.name)) {
        await page.screenshot({ path: resolve(SHOT_DIR, `${name}-${vpName}.png`), fullPage: true });
      }
      const res = await new AxeBuilder({ page }).analyze();
      for (const v of res.violations) {
        if (v.impact === 'critical' || v.impact === 'serious') {
          findings.push({
            route: name,
            viewport: vpName,
            rule: v.id,
            impact: v.impact,
            nodes: v.nodes.length,
            sample: (v.nodes[0]?.target ?? []).join(' ').slice(0, 70),
          });
          details.push({
            route: name, viewport: vpName, rule: v.id,
            nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary, html: n.html.slice(0, 160) })),
          });
        }
      }
      const layout = await page.evaluate(() => {
        const de = document.documentElement;
        const text = document.body.innerText;
        const bad = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/.exec(text);
        return { overflowX: de.scrollWidth - de.clientWidth, bad: bad ? bad[0] : '' };
      });
      if (layout.overflowX > 1) layoutIssues.push(`${name}-${vpName}: horizontal overflow ${layout.overflowX}px`);
      if (layout.bad) layoutIssues.push(`${name}-${vpName}: raw "${layout.bad}" visible in text`);
    }
    await page.close();
  }

  const shellReady = async (page: Page) => {
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15_000 });
    await page.waitForLoadState('load');
  };

  test('home', async () => {
    await audit(authed, 'home', '/', async (p) => {
      await shellReady(p);
      await expect(p.getByText('Acme Marketing Site').locator('visible=true').first()).toBeVisible({ timeout: 15_000 });
    });
  });

  test('auth (logged out)', async () => {
    await audit(anon, 'auth', '/auth', async (p) => {
      await expect(p.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
    });
  });

  test('auth register mode + notice', async () => {
    await audit(anon, 'auth-register', '/auth', async (p) => {
      await expect(p.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
    }, async (p) => {
      await p.getByRole('button', { name: /^register$/i }).first().click().catch(() => {});
    });
  });

  const openProject = async (p: Page) => {
    await expect(p.locator('[data-role="list-body"] tr').first()).toBeVisible({ timeout: 20_000 });
  };

  test('project list view', async () => {
    await audit(authed, 'project-list', `/projects/${projectId}`, openProject);
  });

  test('project kanban view', async () => {
    await audit(authed, 'project-kanban', `/projects/${projectId}`, openProject, async (p) => {
      await p.locator('[data-role="toggle-kanban"]').click();
      await expect(p.locator('[data-role="kanban-column"] [data-role="kanban-cards"] > *').first()).toBeVisible();
    });
  });

  test('project analytics', async () => {
    await audit(authed, 'project-analytics', `/projects/${projectId}`, openProject, async (p) => {
      await expect(p.locator('[data-role="analytics"]')).toBeVisible({ timeout: 10_000 });
      await p.locator('[data-role="analytics"]').scrollIntoViewIfNeeded();
    });
  });

  test('project annotation detail', async () => {
    await audit(authed, 'project-detail', `/projects/${projectId}`, openProject, async (p) => {
      await p.getByText('Checkout button does nothing').first().click();
      await expect(p.locator('[data-section="detail"]')).toBeVisible({ timeout: 10_000 });
      await expect(p.locator('[data-section="detail"]').getByText('Reproduced on an iPhone 14')).toBeVisible({ timeout: 10_000 });
    });
  });

  test('project heatmap + replay', async () => {
    await audit(authed, 'project-heatmap', `/projects/${projectId}`, openProject, async (p) => {
      await p.locator('[data-role="heatmap-btn"]').click();
      await expect(p.locator('[data-role="heatmap-container"]')).toBeVisible({ timeout: 10_000 });
      await p.waitForTimeout(500);
    });
  });

  for (const tab of ['profile', 'notifications', 'guidelines', 'teams', 'appearance'] as const) {
    test(`settings ${tab}`, async () => {
      await audit(
        authed,
        `settings-${tab}`,
        '/settings',
        async (p) => {
          await expect(p.locator('[data-role="tab-' + tab + '"]')).toBeVisible({ timeout: 15_000 });
        },
        async (p) => {
          await p.locator(`[data-role="tab-${tab}"]`).click();
          await p.waitForTimeout(600);
        },
      );
    });
  }

  test('onboarding steps', async () => {
    const stepName = ['1-project', '2-key', '3-snippet', '4-verify'];
    for (let step = 0; step < 4; step++) {
      await audit(
        authed,
        `onboarding-${stepName[step]}`,
        '/onboarding',
        async (p) => {
          await expect(p.locator('#onboarding-step-heading')).toBeVisible({ timeout: 15_000 });
        },
        async (p) => {
          if (step >= 1) {
            await p.locator('#onboarding-project-select').selectOption({ label: 'Acme Marketing Site' }).catch(() => {});
            await p.getByRole('button', { name: 'Use this project' }).click();
          }
          if (step >= 2) {
            await p.getByRole('button', { name: 'Issue widget key' }).click();
            await expect(p.locator('#onboarding-snippet')).toBeVisible({ timeout: 15_000 });
          }
          if (step >= 3) {
            await p.getByRole('button', { name: /continue|next|verify|install/i }).first().click();
          }
          await p.waitForTimeout(300);
        },
      );
    }
  });

  for (const route of ['reports', 'workflows', 'integrations', 'portals'] as const) {
    test(route, async () => {
      await audit(authed, route, `/${route}`, async (p) => {
        await shellReady(p);
        await expect(p.locator('h1').first()).toBeVisible({ timeout: 15_000 });
      });
    });
  }

  test('review link', async () => {
    await audit(authed, 'review', `/review/${sharedLinkId}`, async (p) => {
      await expect(p.locator('[data-fl-review-root]')).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(async () => ((await p.locator('[data-slot="status"]').textContent()) ?? '').trim(), { timeout: 20_000 })
        .not.toMatch(/^$|Loading preview/);
      await p.waitForTimeout(800); // let the framed document paint
    });
  });

  test('shared link: password prompt, then unlocked', async ({ browser }) => {
    // The unlock sets a 30-min link-scoped access cookie, so each state gets
    // its own fresh anonymous context (audit() reloads per viewport).
    const fresh = () => browser.newContext({ storageState: { cookies: [], origins: [] } });
    const locked = await fresh();
    await audit(locked, 'shared-locked', `/shared/${protectedLinkId}`, async (p) => {
      await expect(p.locator('input[type="password"]')).toBeVisible({ timeout: 15_000 });
    });
    await locked.close();

    // Unlock once; the grant cookie then carries both viewport passes.
    const unlocked = await fresh();
    const up = await unlocked.newPage();
    await up.goto(`/shared/${protectedLinkId}`);
    await up.locator('input[type="password"]').fill('Review-2026!');
    await up.locator('input[type="password"]').press('Enter');
    await expect(up.locator('input[type="password"]')).toBeHidden({ timeout: 15_000 });
    await up.close();
    await audit(unlocked, 'shared-unlocked', `/shared/${protectedLinkId}`, async (p) => {
      await expect(p.locator('input[type="password"]')).toBeHidden({ timeout: 15_000 });
      // The demo's protected project has no annotations: the unlocked view
      // shows its empty state rather than the prompt.
      await expect(p.getByText('No annotations in this project')).toBeVisible({ timeout: 15_000 });
    });
    await unlocked.close();

    // A link WITHOUT a password opens straight to the read-only list.
    await audit(anon, 'shared-open', `/shared/${sharedLinkId}`, async (p) => {
      await expect(p.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });
      await expect(p.locator('input[type="password"]')).toBeHidden();
    });
  });

  test('accept invitation (signed in + signed out)', async () => {
    await audit(authed, 'invitations-accept', `/invitations/accept?token=${inviteToken}`, async (p) => {
      await expect(p.locator('[data-role="invite-status"]')).toBeVisible({ timeout: 15_000 });
      await expect(p.locator('[data-role="invite-accept"], [data-role="invite-login"]')).toBeVisible({ timeout: 15_000 });
    });
    await audit(anon, 'invitations-accept-loggedout', `/invitations/accept?token=x`, async (p) => {
      await expect(p.locator('[data-role="invite-login"]')).toBeVisible({ timeout: 15_000 });
    });
  });

  test('verify-email (bad token)', async () => {
    await audit(anon, 'verify-email', '/verify-email/not-a-real-token', async (p) => {
      await expect(p.locator('#root')).not.toBeEmpty({ timeout: 15_000 });
      await p.waitForTimeout(1_000);
    });
  });

  test('404', async () => {
    await audit(authed, 'not-found', '/this/page/does-not-exist', async (p) => {
      await expect(p.locator('#root')).not.toBeEmpty({ timeout: 15_000 });
    });
  });

  test('project analytics (mobile summary expanded)', async () => {
    await audit(authed, 'project-analytics-expanded', `/projects/${projectId}`, openProject, async (p) => {
      // The summary toggle only exists below the mobile breakpoint.
      const toggle = p.locator('[data-role="analytics-toggle"]');
      if (await toggle.isVisible()) {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      }
      await p.locator('[data-role="analytics"]').scrollIntoViewIfNeeded();
    });
  });

  test('empty states in a fresh workspace', async ({ browser }) => {
    const ellis = await ensureUser({ email: 'ellis.park@acmestudio.dev', name: 'Ellis Park', pro: true });
    // Clean slate: no projects, portals, rules or SLA policies.
    for (const table of ['client_portals', 'automation_rules', 'sla_policies']) {
      sql(`delete from ${table} where org_id = '${ellis.orgId}'`);
    }
    const list = (await (await ellis.ctx.get('/api/v1/projects')).json()) as { data?: Array<{ id: string; name: string }> };
    for (const p of list.data ?? []) {
      await ellis.ctx.delete(`/api/v1/projects/${p.id}`, { data: { confirmationToken: p.name } });
    }
    const empty = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const login = await empty.newPage();
    await login.goto('/auth');
    await login.locator('input[name="email"]').fill(ellis.email);
    await login.locator('input[name="password"]').fill(DEMO_PASSWORD);
    await login.getByRole('button', { name: 'Log In' }).click();
    await expect(login).not.toHaveURL(/\/auth/, { timeout: 20_000 });
    await login.close();

    const hasEmpty = async (p: Page) => {
      await expect(p.locator('main .pp-empty-state, [data-slot="content"] .pp-empty-state').first()).toBeVisible({ timeout: 15_000 });
    };
    await audit(empty, 'home-empty', '/', hasEmpty);
    await audit(empty, 'workflows-empty', '/workflows', hasEmpty);
    await audit(empty, 'portals-empty', '/portals', hasEmpty);
    await audit(empty, 'reports-empty', '/reports', hasEmpty);
    await empty.close();
    await ellis.dispose();
  });

  test('report: zero critical/serious axe violations, no layout defects', async () => {
    writeFileSync(resolve(process.cwd(), 'test-results', `axe-${test.info().project.name}.json`), JSON.stringify(details, null, 2));
    if (findings.length) {
      console.log('\nAXE critical/serious violations:');
      console.table(findings);
    }
    if (layoutIssues.length) console.log('\nLayout issues:\n' + layoutIssues.join('\n'));
    if (consoleIssues.length) console.log('\nConsole/page errors:\n' + [...new Set(consoleIssues)].join('\n'));
    expect(findings, 'axe critical/serious violations').toEqual([]);
    expect(layoutIssues, 'layout issues (overflow / raw undefined text)').toEqual([]);
  });
});
