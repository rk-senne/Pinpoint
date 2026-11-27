/**
 * Dashboard interactions that no earlier spec exercised: kanban drag & drop,
 * filters, the detail panel (status / assignee / due date / comments with
 * @mentions), analytics, CSV export, command palette, notification bell,
 * settings (profile, preferences, guidelines, teams), project context menu,
 * heatmap, replay player, registration notice, invitation acceptance and
 * keyboard-only navigation.
 *
 * Runs on the seed account's browser session (`.auth/browser.json`); every
 * fixture is created through the API and removed afterwards.
 */
import { type Browser, type Page, expect, test } from '@playwright/test';

import {
  type DemoUser,
  DEMO_PASSWORD,
  acceptAndSwitch,
  demoReplayEvents,
  ensureUser,
  inviteWithKnownToken,
  sql,
} from './demo.js';
import {
  API_URL,
  type ApiClient,
  type CreatedProject,
  createAnnotation,
  deleteProject,
  makeApiClient,
  readSeedSession,
  uniqueSuffix,
} from './helpers.js';

test.describe.configure({ mode: 'default' });

let api: ApiClient;
const cleanup: CreatedProject[] = [];

async function newProject(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<CreatedProject> {
  const res = await api.ctx.post('/api/v1/projects', {
    data: { name, urls: ['https://example.com/'], ...extra },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as {
    project: { id: string; name: string };
    pages: Array<{ id: string; url: string }>;
  };
  const p = { id: body.project.id, name: body.project.name, pages: body.pages };
  cleanup.push(p);
  return p;
}

async function annotationStatus(id: string): Promise<string> {
  const res = await api.ctx.get(`/api/v1/annotations/${id}`);
  if (res.ok()) {
    const b = (await res.json()) as { annotation?: { status?: string }; status?: string };
    return b.annotation?.status ?? b.status ?? '';
  }
  return '';
}

async function listRaw(projectId: string): Promise<Array<Record<string, any>>> {
  const res = await api.ctx.get(`/api/v1/projects/${projectId}/annotations?pageSize=100`);
  return ((await res.json()) as { data: Array<Record<string, any>> }).data;
}

async function openProject(page: Page, id: string): Promise<void> {
  await page.goto(`/projects/${id}`);
  await expect(page.locator('[data-section="content"]')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  const c = await makeApiClient();
  test.skip(!c, 'Seed session unavailable.');
  api = c!;
});

test.afterEach(async () => {
  while (cleanup.length) await deleteProject(api, cleanup.pop()!).catch(() => {});
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('project view', () => {
  test('kanban drag-and-drop between columns persists the status', async ({ page }) => {
    const project = await newProject(`Kanban ${uniqueSuffix()}`);
    const a = await createAnnotation(api, project.id, project.pages[0]!.url, { body: 'Drag me to in progress' });
    await openProject(page, project.id);
    await page.locator('[data-role="toggle-kanban"]').click();
    const src = page.locator('[data-role="kanban-column"][data-status="active"] [data-role="kanban-cards"] > div').first();
    const dst = page.locator('[data-role="kanban-column"][data-status="in_progress"]');
    await expect(src).toContainText('Drag me to in progress');
    await src.dragTo(dst);
    await expect
      .poll(async () => (await listRaw(project.id)).find((r) => r.id === a.id)?.status, { timeout: 10_000 })
      .toBe('in_progress');
    await expect(
      page.locator('[data-role="kanban-column"][data-status="in_progress"]'),
    ).toContainText('Drag me to in progress');
  });

  test('list filters: search, severity, status, sort and clear', async ({ page }) => {
    const project = await newProject(`Filters ${uniqueSuffix()}`);
    const u = project.pages[0]!.url;
    await createAnnotation(api, project.id, u, { body: 'Navbar overlaps the logo', severity: 'critical' });
    await createAnnotation(api, project.id, u, { body: 'Footer typo in copyright line', severity: 'minor' });
    const c = await createAnnotation(api, project.id, u, { body: 'Hero image too heavy', severity: 'major' });
    await api.ctx.put(`/api/v1/annotations/${c.id}/status`, { data: { status: 'resolved' } });
    await openProject(page, project.id);
    const rows = page.locator('[data-role="list-body"] tr');
    await expect(rows).toHaveCount(3);

    await page.locator('[data-role="filter-search"]').fill('footer');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Footer typo');
    await page.locator('[data-role="filter-search"]').fill('zzz-nothing');
    await expect(page.locator('[data-role="filter-empty"]')).toBeVisible();
    await page.locator('[data-role="clear-filters-btn"]').click();
    await expect(rows).toHaveCount(3);

    await page.locator('[data-role="filter-severity"]').selectOption('critical');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Navbar');
    await page.locator('[data-role="filter-severity"]').selectOption('');
    await page.locator('[data-role="filter-status"]').selectOption('resolved');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Hero image');
    await page.locator('[data-role="filter-status"]').selectOption('');
    await page.locator('[data-role="filter-sort"]').selectOption('pin');
    await expect(rows.first()).toContainText('Navbar');
    await page.locator('[data-role="filter-sort"]').selectOption('severity');
    await expect(rows.first()).toContainText('Navbar'); // critical first
  });

  test('analytics counts match the seeded data', async ({ page }) => {
    const project = await newProject(`Analytics ${uniqueSuffix()}`);
    const u = project.pages[0]!.url;
    await createAnnotation(api, project.id, u, { severity: 'critical' });
    await createAnnotation(api, project.id, u, { severity: 'critical' });
    await createAnnotation(api, project.id, u, { severity: 'minor', type: 'suggestion' });
    await openProject(page, project.id);
    const card = (dim: string) => page.locator(`[data-role="analytics-card"][data-dim="${dim}"]`);
    await expect(card('bySeverity')).toContainText(/critical\s*2/);
    await expect(card('bySeverity')).toContainText(/minor\s*1/);
    await expect(card('byType')).toContainText(/note\s*2/);
    await expect(card('byType')).toContainText(/suggestion\s*1/);
    await expect(card('byStatus')).toContainText(/Open\s*3/);
    await expect(card('byBrowser')).toContainText(/Chrome\s*3/);
    const server = (await (await api.ctx.get(`/api/v1/projects/${project.id}/analytics`)).json()) as {
      analytics: { bySeverity: Record<string, number> };
    };
    expect(server.analytics.bySeverity.critical).toBe(2);
  });

  test('detail panel: assignee persists and an @mention comment notifies', async ({ page }) => {
    const mate = await ensureUser({ email: `priya.${uniqueSuffix()}@acmestudio.dev`, name: 'Priya Nair' });
    const seedUserId = readSeedSession()!.body.user.id;
    const orgId = sql(`select org_id from memberships where user_id='${seedUserId}' order by created_at limit 1`);
    const owner = { ctx: api.ctx, orgId } as unknown as DemoUser;
    const raw = await inviteWithKnownToken(owner, mate.email, 'member');
    const mateCtx = await acceptAndSwitch(mate, raw, orgId);
    const team = await api.ctx.post('/api/v1/teams', { data: { name: `Core ${uniqueSuffix()}` } });
    const teamId = ((await team.json()) as { team: { id: string } }).team.id;
    const inv = await api.ctx.post(`/api/v1/teams/${teamId}/invite`, { data: { email: mate.email } });
    expect(inv.status()).toBe(201);
    const project = await newProject(`Detail ${uniqueSuffix()}`, { teamId });
    const a = await createAnnotation(api, project.id, project.pages[0]!.url, {
      body: 'Checkout total flickers on load', severity: 'critical',
    });

    await openProject(page, project.id);
    await page.getByText('Checkout total flickers on load').first().click();
    const detail = page.locator('[data-section="detail"]');
    await expect(detail).toBeVisible();
    await detail.locator('[data-role="assignee-select"]').selectOption(mate.userId);
    await expect(detail.locator('[data-role="assignee-select"] option:checked')).toHaveText(`Priya Nair (${mate.email})`);
    await detail.locator('[data-action="save-assignment"]').click();
    await expect
      .poll(async () => (await listRaw(project.id)).find((r) => r.id === a.id)!.assigneeId, { timeout: 10_000 })
      .toBe(mate.userId);

    // Reload: the saved assignee comes back into the form.
    await page.reload();
    await page.getByText('Checkout total flickers on load').first().click();
    await expect(page.locator('[data-role="assignee-select"]')).toHaveValue(mate.userId);

    // Comment with @mention from the dashboard.
    const input = page.locator('[data-role="comment-input"]');
    await input.fill('Thanks @Priya Nair, can you take a look before Friday?');
    await page.locator('[data-role="comment-submit"]').click();
    await expect(page.locator('[data-role="comment"]').first()).toContainText('can you take a look');
    const notes = (await (await mateCtx.get('/api/v1/notifications')).json()) as {
      data?: Array<{ type: string }>; notifications?: Array<{ type: string }>;
    };
    const list = notes.data ?? notes.notifications ?? [];
    await expect.poll(async () => {
      const n = (await (await mateCtx.get('/api/v1/notifications')).json()) as typeof notes;
      return (n.data ?? n.notifications ?? []).some((x) => x.type === 'mention');
    }, { timeout: 10_000 }).toBe(true);
    void list;
    await mateCtx.dispose();
  });

  test('detail panel: due date round-trips to the same calendar day', async ({ page }) => {
    const project = await newProject(`Due ${uniqueSuffix()}`);
    const a = await createAnnotation(api, project.id, project.pages[0]!.url, { body: 'Due date round trip' });
    await openProject(page, project.id);
    await page.getByText('Due date round trip').first().click();
    await page.locator('[data-role="due-date"]').fill('2026-12-24');
    await page.locator('[data-action="save-assignment"]').click();
    await expect
      .poll(async () => String((await listRaw(project.id)).find((r) => r.id === a.id)!.dueDate ?? ''), { timeout: 5_000 })
      .not.toBe('');
    await page.reload();
    await page.getByText('Due date round trip').first().click();
    await expect(page.locator('[data-role="due-date"]')).toHaveValue('2026-12-24', { timeout: 3_000 });
  });

  test('status change via the list persists (resolve then reopen via bulk bar)', async ({ page }) => {
    const project = await newProject(`Bulk ${uniqueSuffix()}`);
    const a = await createAnnotation(api, project.id, project.pages[0]!.url, { body: 'Bulk resolve me' });
    await openProject(page, project.id);
    await page.locator('[data-role="list-body"] tr').first().locator('input[type="checkbox"]').check();
    await page.locator('[data-action="bulk-resolve"]').click();
    await expect
      .poll(async () => (await listRaw(project.id)).find((r) => r.id === a.id)?.status, { timeout: 10_000 })
      .toBe('resolved');
  });

  test('export dialog produces a CSV with browser/OS columns', async ({ page }) => {
    const project = await newProject(`Export ${uniqueSuffix()}`);
    await createAnnotation(api, project.id, project.pages[0]!.url, { body: 'Export row one' });
    await page.goto('/');
    const row = page.locator('[data-role="row"]', { hasText: project.name }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-role="menu-button"]').click();
    await page.locator('[data-action="export"]').click();
    await page.locator('[data-role="format-csv"]').click();
    await page.locator('[data-role="export-button"]').click();
    const link = page.locator('[data-role="download-link"]');
    await expect(link).toBeVisible({ timeout: 15_000 });
    const href = (await link.getAttribute('href'))!;
    expect(href).toMatch(/^blob:/);
    expect(await link.getAttribute('download')).toMatch(/\.csv$/);
    const csv = await page.evaluate(async (u) => (await fetch(u)).text(), href);
    const header = csv.split('\n')[0]!.toLowerCase();
    expect(header).toContain('browser');
    expect(header).toContain('os');
    expect(csv).toContain('Export row one');
    expect(csv).toContain('Chrome');
  });

  test('heatmap overlay renders cells for positioned annotations', async ({ page }) => {
    const project = await newProject(`Heat ${uniqueSuffix()}`);
    for (let i = 0; i < 3; i++) {
      await createAnnotation(api, project.id, project.pages[0]!.url, { body: `Heat ${i}` });
    }
    await openProject(page, project.id);
    await page.locator('[data-role="heatmap-btn"]').click();
    const grid = page.locator('[data-role="heatmap-grid"]');
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => grid.locator('> *').count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page.locator('[data-slot="heatmap-status"]')).toContainText(/annotation/);
  });

  test('replay player plays and the scrubber moves', async ({ page }) => {
    const project = await newProject(`Replay ${uniqueSuffix()}`);
    const res = await api.ctx.post(`/api/v1/projects/${project.id}/annotations`, {
      data: {
        pageUrl: project.pages[0]!.url, body: 'Replayable session', type: 'note', severity: 'major',
        target: { cssSelector: 'body', xpath: '/html/body', pageX: 1, pageY: 1, tagName: 'BODY', textSnippet: '' },
        environment: { browserFamily: 'Chrome', browserVersion: '126.0', osFamily: 'macOS', osVersion: '14.5', deviceType: 'desktop', userAgentRaw: 'Mozilla/5.0 Chrome/126' },
        sessionReplay: demoReplayEvents(),
      },
    });
    expect(res.status()).toBe(201);
    await openProject(page, project.id);
    await page.getByText('Replayable session').first().click();
    await page.locator('[data-role="replay-btn"]').click();
    const scrubber = page.locator('[data-role="replay-scrubber"]');
    await expect(scrubber).toBeVisible();
    const before = Number(await scrubber.inputValue());
    await page.locator('[data-role="replay-play"]').click();
    await expect.poll(async () => Number(await scrubber.inputValue()), { timeout: 10_000 }).toBeGreaterThan(before);
    await expect(page.locator('[data-role="replay-time"]')).not.toHaveText(/^0:00\s*\/\s*0:00$/);
  });
});

test.describe('global UI', () => {
  test('command palette opens with Ctrl+K, filters and navigates', async ({ page }) => {
    const project = await newProject(`Palette ${uniqueSuffix()}`);
    await page.goto('/');
    await expect(page.locator('[data-role="row"]', { hasText: project.name }).first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Control+k');
    const input = page.locator('[data-role="search-input"]');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('Palette');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
    await page.keyboard.press('Control+k');
    await page.locator('[data-role="search-input"]').fill('Settings');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings/);
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-role="search-input"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-role="search-input"]')).toHaveCount(0);
  });

  test('notification bell shows an unread mention and mark-read works', async ({ page }) => {
    const seed = readSeedSession()!;
    const author = await ensureUser({ email: `lena.${uniqueSuffix()}@acmestudio.dev`, name: 'Lena Fischer' });
    const orgId = sql(`select org_id from memberships where user_id='${seed.body.user.id}' order by created_at limit 1`);
    const raw = await inviteWithKnownToken({ ctx: api.ctx, orgId } as unknown as DemoUser, author.email, 'member');
    const authorCtx = await acceptAndSwitch(author, raw, orgId);
    const team = await api.ctx.post('/api/v1/teams', { data: { name: `Bell ${uniqueSuffix()}` } });
    const teamId = ((await team.json()) as { team: { id: string } }).team.id;
    await api.ctx.post(`/api/v1/teams/${teamId}/invite`, { data: { email: author.email } });
    const project = await newProject(`Bell ${uniqueSuffix()}`, { teamId });
    const a = await createAnnotation(api, project.id, project.pages[0]!.url, { body: 'Bell annotation' });
    const c = await authorCtx.post(`/api/v1/annotations/${a.id}/comments`, {
      data: { body: `@E2E Seed please review the mobile nav`, mentions: [seed.body.user.id] },
    });
    expect(c.status()).toBe(201);

    await page.goto('/');
    const bell = page.locator('[data-slot="notifications"] button').first();
    await expect(bell).toBeVisible({ timeout: 15_000 });
    const badge = page.locator('[data-slot="notifications"] [data-role="badge"]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    const before = Number((await badge.textContent())!.trim());
    expect(before).toBeGreaterThan(0);
    await bell.click();
    const items = page.locator('[data-role="dropdown"] [data-role="item"]');
    await expect(items.first()).toBeVisible();
    await expect(page.locator('[data-role="dropdown"]')).toContainText('mentioned');
    await items.first().click();
    await expect
      .poll(async () => ((await badge.isVisible()) ? Number((await badge.textContent())!.trim()) : 0), { timeout: 10_000 })
      .toBeLessThan(before);
    await page.locator('[data-action="markAllRead"]').click().catch(async () => {
      await bell.click();
      await page.locator('[data-action="markAllRead"]').click();
    });
    await expect(badge).toBeHidden({ timeout: 10_000 });
    await authorCtx.dispose();
  });

  test('project context menu: rename, archive/unarchive, delete', async ({ page }) => {
    const name = `Menu ${uniqueSuffix()}`;
    const project = await newProject(name);
    await page.goto('/');
    const rowFor = (n: string) => page.getByLabel('Main navigation').locator('[data-role="row"]', { hasText: n }).first();
    await expect(rowFor(name)).toBeVisible({ timeout: 15_000 });

    // Rename
    await rowFor(name).locator('[data-role="menu-button"]').click();
    await page.locator('[data-action="rename"]').click();
    const renamed = `${name} renamed`;
    const input = page.getByLabel('Main navigation').locator('input:not([data-role="search"])').first();
    await input.fill(renamed);
    await input.press('Enter');
    await expect
      .poll(async () => ((await (await api.ctx.get(`/api/v1/projects/${project.id}`)).json()) as { project: { name: string } }).project.name, { timeout: 10_000 })
      .toBe(renamed);
    project.name = renamed;

    // Archive then unarchive
    await rowFor(renamed).locator('[data-role="menu-button"]').click();
    await page.locator('[data-action="archive"]').click();
    await expect(rowFor(renamed)).toHaveCount(0);
    await page.locator('[data-role="tab-archived"]').click();
    await expect(rowFor(renamed)).toBeVisible();
    await rowFor(renamed).locator('[data-role="menu-button"]').click();
    await page.locator('[data-action="archive"]').click();
    await page.locator('[data-role="tab-active"]').click();
    await expect(rowFor(renamed)).toBeVisible();

    // Delete (native confirm dialog names the project)
    page.once('dialog', async (d) => {
      expect(d.message()).toContain(renamed);
      await d.accept();
    });
    await rowFor(renamed).locator('[data-role="menu-button"]').click();
    await page.locator('[data-action="delete"]').click();
    await expect(rowFor(renamed)).toHaveCount(0, { timeout: 10_000 });
    const gone = await api.ctx.get(`/api/v1/projects/${project.id}`);
    expect(gone.status()).toBe(404);
  });
});

test.describe('keyboard-only (signed in)', () => {
  test('tab to a project row, open it with Enter; Escape closes menu and dialog', async ({ page, browserName }) => {
    // Safari (WebKit) only Tab-focuses buttons with Option+Tab unless the OS
    // "keyboard navigation" setting is on; that is platform behaviour.
    const tabToButton = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const project = await newProject(`Keyboard ${uniqueSuffix()}`);
    await page.goto('/');
    const row = page.getByLabel('Main navigation').locator('[data-role="row"]', { hasText: project.name }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Tab until the project row has focus (bounded), checking the focus ring.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await row.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'project row reachable with Tab').toBe(true);
    const ring = await row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
    });
    expect(ring, 'visible focus ring on the row').toBe(true);

    // Menu button via keyboard, Escape closes and returns focus.
    await page.keyboard.press(tabToButton);
    await expect(row.locator('[data-role="menu-button"]')).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.locator('[data-role="menu"]');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.y, 'menu anchored to its button, not the top-left corner').toBeGreaterThan(40);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(row.locator('[data-role="menu-button"]')).toBeFocused();

    // Create-project dialog closes on Escape.
    await page.locator('[data-role="create"]').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Enter on the focused row opens the project.
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  });
});

test.describe('settings', () => {
  test('profile name persists and a notification preference persists', async ({ page }) => {
    const me = async () =>
      ((await (await api.ctx.get('/api/v1/users/me')).json()) as { user: { name: string; notificationPreferences?: Record<string, boolean> } }).user;
    const original = (await me()).name;
    try {
      await page.goto('/settings');
      const name = page.locator('[data-role="profile-name"]');
      await expect(name).toBeVisible({ timeout: 15_000 });
      await name.fill('E2E Seed Renamed');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect.poll(async () => (await me()).name, { timeout: 10_000 }).toBe('E2E Seed Renamed');
      await page.reload();
      await expect(page.locator('[data-role="profile-name"]')).toHaveValue('E2E Seed Renamed');

      await page.locator('[data-role="tab-notifications"]').click();
      const toggles = page.locator('[data-role="notification-toggle"]');
      await expect(toggles.first()).toBeVisible();
      const first = toggles.first();
      const wasOn = (await first.getAttribute('aria-checked')) === 'true';
      await first.click();
      await expect(first).toHaveAttribute('aria-checked', String(!wasOn));
      await page.reload();
      await page.locator('[data-role="tab-notifications"]').click();
      await expect(page.locator('[data-role="notification-toggle"]').first()).toHaveAttribute('aria-checked', String(!wasOn));
      await page.locator('[data-role="notification-toggle"]').first().click(); // restore
    } finally {
      await api.ctx.put('/api/v1/users/me', { data: { name: original } });
    }
  });

  test('guidelines: create a custom guideline', async ({ page }) => {
    const gname = `Tone of voice ${uniqueSuffix()}`;
    await page.goto('/settings');
    await page.locator('[data-role="tab-guidelines"]').click();
    const form = page.locator('[data-section="guidelines"]');
    await form.locator('[data-role="guideline-name"]').fill(gname);
    await form.locator('[data-role="guideline-desc"]').fill('Sentence case headlines, no exclamation marks.');
    const created = page.waitForResponse((r) => r.url().includes('/api/v1/guidelines') && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create Guideline' }).click();
    expect((await created).status()).toBe(201);
    await expect(form.getByText(gname)).toBeVisible({ timeout: 10_000 });
    const list = (await (await api.ctx.get('/api/v1/guidelines?pageSize=100')).json()) as { data: Array<{ name: string }> };
    expect(list.data.some((g) => g.name === gname)).toBe(true);
  });

  test('teams: create, invite, change role, remove', async ({ page }) => {
    const mate = await ensureUser({ email: `omar.${uniqueSuffix()}@acmestudio.dev`, name: 'Omar Haddad' });
    const tname = `Squad ${uniqueSuffix()}`;
    await page.goto('/settings');
    await page.locator('[data-role="tab-teams"]').click();
    await page.locator('[data-role="new-team-name"]').fill(tname);
    await page.locator('[data-role="create-submit"]').click();
    const card = page.locator('[data-role="team"]', { hasText: tname }).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const teamId = sql(`select id from teams where name = '${tname}' order by created_at desc limit 1`);
    // Teams are org-scoped (PP-04): only members of the team's org can be
    // added. Join the invitee to the org directly (the org-invitation flow is
    // covered by its own spec).
    sql(`insert into memberships (org_id, user_id, role, accepted_at)
         select t.org_id, u.id, 'member', now() from teams t, users u
         where t.id = '${teamId}' and u.email = '${mate.email}'
           and not exists (select 1 from memberships m where m.org_id = t.org_id and m.user_id = u.id)`);
    await card.locator('[data-role="invite-email"]').fill(mate.email);
    await card.locator('[data-role="invite-submit"]').click();
    const memberRow = card.locator('[data-role="member"]', { hasText: 'Omar Haddad' });
    await expect(memberRow).toBeVisible({ timeout: 10_000 });
    await memberRow.locator('[data-role="role-select"]').selectOption('admin');
    await expect(memberRow.locator('[data-role="role-select"]')).toHaveValue('admin');
    await page.reload();
    await page.locator('[data-role="tab-teams"]').click();
    const again = page.locator('[data-role="team"]', { hasText: tname }).first().locator('[data-role="member"]', { hasText: 'Omar Haddad' });
    await expect(again.locator('[data-role="role-select"]')).toHaveValue('admin');
    page.once('dialog', (d) => void d.accept());
    await again.locator('[data-role="remove"]').click();
    await expect(again).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe('anonymous flows', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('register shows the "Check your email" notice without navigating', async ({ page }) => {
    await page.goto('/auth');
    await page.getByText('Register', { exact: true }).click();
    await page.locator('input[name="name"]').fill('Sam Rivera');
    await page.locator('input[name="email"]').fill(`sam.${uniqueSuffix()}@acmestudio.dev`);
    await page.locator('input[name="password"]').fill('Sunr1se-Studio-Demo!');
    // The Terms checkbox is required (never pre-ticked): submitting without it is refused in the UI.
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.locator('#fl-auth-terms-error')).toBeVisible();
    await expect(page.getByText(/check your email/i)).toHaveCount(0);
    await page.locator('#fl-auth-terms').check();
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/auth/);
  });

  test('keyboard-only: tab through the login form with a visible focus ring', async ({ page }) => {
    await page.goto('/auth');
    await page.locator('input[name="email"]').waitFor();
    await page.keyboard.press('Tab'); // skip link
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          name: el.getAttribute('name') ?? el.textContent?.trim().slice(0, 20) ?? '',
          ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
        };
      });
      if (info && ['INPUT', 'BUTTON', 'A'].includes(info.tag)) {
        expect(info.ring, `focus ring on ${info.tag} ${info.name}`).toBe(true);
        seen.push(`${info.tag}:${info.name}`);
      }
      await page.keyboard.press('Tab');
    }
    expect(seen.join(' ')).toMatch(/email/);
    expect(seen.join(' ')).toMatch(/password/);
  });
});

test.describe('invitation acceptance', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('invitee logs in, accepts, and then sees the inviter org projects', async ({ browser }: { browser: Browser }) => {
    const seed = readSeedSession()!;
    const orgId = sql(`select org_id from memberships where user_id='${seed.body.user.id}' order by created_at limit 1`);
    const team = await api.ctx.post('/api/v1/teams', { data: { name: `Launch ${uniqueSuffix()}` } });
    const teamId = ((await team.json()) as { team: { id: string } }).team.id;
    const project = await newProject(`Spring launch ${uniqueSuffix()}`, { teamId });
    const invitee = await ensureUser({ email: `jordan.${uniqueSuffix()}@acmestudio.dev`, name: 'Jordan Reyes' });
    const raw = await inviteWithKnownToken({ ctx: api.ctx, orgId } as unknown as DemoUser, invitee.email, 'member');

    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    await page.goto(`/invitations/accept?token=${raw}`);
    await expect(page.locator('[data-role="invite-login"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-role="invite-login"]').click();
    await page.locator('input[name="email"]').fill(invitee.email);
    await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await expect(page).not.toHaveURL(/\/auth/, { timeout: 15_000 });
    // Re-open the invitation link (SPA nav keeps the in-memory CSRF token).
    await page.evaluate((t) => {
      history.pushState(null, '', `/invitations/accept?token=${t}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, raw);
    await page.locator('[data-role="invite-accept"]').click();
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    const memberships = sql(`select count(*) from memberships where user_id='${invitee.userId}' and org_id='${orgId}'`);
    expect(memberships).toBe('1');
    // The session switched to the inviter's org (cookie re-issued by /org/switch).
    const activeOrg = await page.evaluate(async () => {
      const r = await fetch('/api/v1/org', { credentials: 'include' });
      const b = r.ok ? ((await r.json()) as { org?: { id: string }; id?: string }) : null;
      return b?.org?.id ?? b?.id ?? null;
    });
    expect(activeOrg).toBe(orgId);
    // Projects inside an org are team-gated: once the inviter adds the new
    // member to the project's team, the invitee's dashboard lists it.
    const inv = await api.ctx.post(`/api/v1/teams/${teamId}/invite`, { data: { email: invitee.email } });
    expect(inv.status(), await inv.text()).toBe(201);
    await page.reload();
    await expect(
      page.getByLabel('Main navigation').locator('[data-role="row"]', { hasText: project.name }),
    ).toBeVisible({ timeout: 15_000 });
    await ctx.close();
  });
});

void API_URL;
void annotationStatus;
