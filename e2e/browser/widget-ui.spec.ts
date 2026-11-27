/**
 * Real-browser UI E2E for the embeddable feedback widget
 * (`/widget/pinpoint-widget.js`) on a realistic customer storefront page.
 *
 * The widget renders into a CLOSED shadow root (so host CSS / scripts can't
 * reach it). Playwright can't pierce closed roots, so an init script forces
 * `attachShadow` into `open` mode for the test only — the bundle and its
 * behaviour are otherwise untouched.
 *
 * Covers: trigger placement (bottom-right default + `position` option),
 * opening, keyboard access (Tab order, focus trap, Escape, focus return),
 * inline validation, success state (and the row landing via the API), the
 * error state when the API rejects the origin, mobile 390×844 rendering,
 * and an axe scan with the widget open.
 *
 * Screenshots: docs/screenshots/widget-*.png.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type Page, expect, test } from '@playwright/test';

import {
  type ApiClient,
  type CreatedProject,
  API_URL,
  createProject,
  createWidgetKey,
  deleteProject,
  listAnnotations,
  makeApiClient,
  uniqueSuffix,
} from './helpers.js';

const SHOTS = resolve(process.cwd(), '../docs/screenshots');
const OK_PORT = 5441;
const BLOCKED_PORT = 5442;
const OK_ORIGIN = `http://127.0.0.1:${OK_PORT}`;
const BLOCKED_ORIGIN = `http://127.0.0.1:${BLOCKED_PORT}`;

function storefront(apiUrl: string, projectKey: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bloom &amp; Co — Plants delivered</title>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:"Helvetica Neue",Arial,sans-serif;color:#1d2b1f;background:#f6f4ef}
  header{display:flex;justify-content:space-between;align-items:center;padding:16px 32px;background:#fff;border-bottom:1px solid #e4e0d6}
  .brand{font-weight:800;font-size:20px;color:#2f5d3a;text-decoration:none}
  nav a{margin-left:20px;color:#1d2b1f;text-decoration:none}
  main{max-width:1080px;margin:0 auto;padding:32px}
  h1{font-size:34px;margin:0 0 8px} .lede{color:#4a5a4d;margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
  .product{background:#fff;border:1px solid #e4e0d6;border-radius:12px;padding:16px}
  .swatch{height:140px;border-radius:8px;background:linear-gradient(135deg,#9cc5a1,#2f5d3a);margin-bottom:12px}
  .product h2{font-size:18px;margin:0 0 4px} .price{font-weight:700;margin:0 0 12px}
  .product button{width:100%;padding:10px;border:0;border-radius:8px;background:#2f5d3a;color:#fff;font-size:15px;cursor:pointer}
  footer{margin-top:40px;padding:24px 32px;background:#1d2b1f;color:#e9efe9;font-size:14px}
  footer a{color:#e9efe9}
</style>
</head>
<body>
<header><a class="brand" href="/">Bloom &amp; Co</a>
  <nav aria-label="Main"><a href="#shop">Shop</a><a href="#care">Plant care</a><a href="#cart">Cart (0)</a></nav>
</header>
<main id="shop">
  <h1>Bring the outdoors in</h1>
  <p class="lede">Healthy plants, delivered in recyclable packaging.</p>
  <section class="grid" aria-label="Products">
    <article class="product"><div class="swatch" role="img" aria-label="Monstera photo"></div><h2>Monstera Deliciosa</h2><p class="price">$39</p><button type="button">Add to cart</button></article>
    <article class="product"><div class="swatch" role="img" aria-label="Snake plant photo"></div><h2>Snake Plant</h2><p class="price">$24</p><button type="button">Add to cart</button></article>
    <article class="product"><div class="swatch" role="img" aria-label="Fiddle leaf fig photo"></div><h2>Fiddle Leaf Fig</h2><p class="price">$52</p><button type="button">Add to cart</button></article>
  </section>
</main>
<footer><p>© 2026 Bloom &amp; Co · <a href="#privacy">Privacy</a> · <a href="#contact">Contact</a></p></footer>
<script src="${apiUrl}/widget/pinpoint-widget.js"></script>
<script>
  var pos = new URLSearchParams(location.search).get('position') || undefined;
  window.Pinpoint.init({ projectKey: ${JSON.stringify(projectKey)}, apiUrl: ${JSON.stringify(apiUrl)}, position: pos });
</script>
</body>
</html>`;
}

function serve(port: number, html: string): Promise<Server> {
  return new Promise((res, rej) => {
    const server = createServer((_q, r) => {
      r.setHeader('Content-Type', 'text/html; charset=utf-8');
      r.end(html);
    });
    server.on('error', rej);
    server.listen(port, '127.0.0.1', () => res(server));
  });
}

/** Force the widget's closed shadow root open (test-only). */
const FORCE_OPEN_SHADOW = (): void => {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadowOpen(init: ShadowRootInit): ShadowRoot {
    return original.call(this, { ...init, mode: 'open' });
  };
};

async function openPage(browser: Browser, url: string, viewport = { width: 1280, height: 800 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, storageState: undefined });
  await ctx.addInitScript(FORCE_OPEN_SHADOW);
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page.locator('#pinpoint-widget-host .pinpoint-trigger')).toBeVisible();
  return page;
}

/** Deep active element id/class inside the widget shadow root. */
async function widgetFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.getElementById('pinpoint-widget-host');
    if (document.activeElement !== host) return `page:${document.activeElement?.tagName.toLowerCase() ?? ''}`;
    const el = host?.shadowRoot?.activeElement as HTMLElement | null;
    return el ? el.id || el.className : '';
  });
}

test.describe('embed widget UI — storefront', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  let api: ApiClient | null;
  let project: CreatedProject | null = null;
  let okServer: Server | null = null;
  let blockedServer: Server | null = null;

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    api = await makeApiClient();
    if (!api) return;
    project = await createProject(api, { name: `widget-ui-${uniqueSuffix()}`, urls: [`${OK_ORIGIN}/`] });
    const key = await createWidgetKey(api, project.id, [OK_ORIGIN]);
    const html = storefront(API_URL, key.rawKey);
    okServer = await serve(OK_PORT, html);
    blockedServer = await serve(BLOCKED_PORT, html);
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => (okServer ? okServer.close(() => r()) : r()));
    await new Promise<void>((r) => (blockedServer ? blockedServer.close(() => r()) : r()));
    if (api && project) await deleteProject(api, project).catch(() => {});
    await api?.dispose();
  });

  test('trigger renders bottom-right by default and honours the position option', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${OK_ORIGIN}/`);
    const trigger = page.locator('#pinpoint-widget-host .pinpoint-trigger');
    await expect(trigger).toHaveAccessibleName('Send feedback');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const box = (await trigger.boundingBox())!;
    expect(Math.round(1280 - (box.x + box.width))).toBe(20);
    expect(Math.round(800 - (box.y + box.height))).toBe(20);
    expect(box.width).toBeGreaterThanOrEqual(44); // touch target
    await page.screenshot({ path: `${SHOTS}/widget-closed.png` });
    await page.context().close();

    const topLeft = await openPage(browser, `${OK_ORIGIN}/?position=top-left`);
    const tl = (await topLeft.locator('#pinpoint-widget-host .pinpoint-trigger').boundingBox())!;
    expect(Math.round(tl.x)).toBe(20);
    expect(Math.round(tl.y)).toBe(20);
    await topLeft.context().close();
  });

  test('keyboard: reachable by Tab, focus trap, Escape closes and focus returns', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${OK_ORIGIN}/`);
    // Tab through the page until the widget trigger is reached (it is the
    // last focusable element in the document).
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await widgetFocus(page)).includes('pinpoint-trigger');
    }
    expect(reached, 'trigger reachable with Tab').toBe(true);

    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#pinpoint-widget-host .pinpoint-trigger')).toHaveAttribute('aria-expanded', 'true');
    expect(await widgetFocus(page)).toBe('pinpoint-description');

    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      order.push(await widgetFocus(page));
    }
    // severity → email → Cancel → Submit → (wraps) description
    expect(order).toEqual(['pinpoint-severity', 'pinpoint-email', 'pinpoint-cancel', 'pinpoint-submit', 'pinpoint-description']);
    await page.keyboard.press('Shift+Tab');
    expect(await widgetFocus(page)).toBe('pinpoint-submit');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await widgetFocus(page)).toContain('pinpoint-trigger');

    // Overlay click (outside the card) also closes.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.mouse.click(40, 400);
    await expect(dialog).toBeHidden();
    await page.context().close();
  });

  test('validation messages, success state, and the row lands via the API', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${OK_ORIGIN}/`);
    await page.locator('#pinpoint-widget-host .pinpoint-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Send feedback' })).toBeVisible();
    await page.waitForTimeout(350); // fade/slide-in
    await page.screenshot({ path: `${SHOTS}/widget-open-desktop.png` });

    const description = page.getByRole('textbox', { name: 'Description' });
    const email = page.getByRole('textbox', { name: /Email/ });
    await description.fill('   ');
    await email.fill('jane@');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('#pinpoint-description-error')).toHaveText('Please describe the issue or idea.');
    await expect(page.locator('#pinpoint-email-error')).toHaveText('Enter a valid email address, or leave it empty.');
    await expect(description).toHaveAttribute('aria-invalid', 'true');
    expect(await widgetFocus(page)).toBe('pinpoint-description');
    // The focused invalid field keeps the error colour, not the brand focus colour.
    await expect.poll(() => description.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(185, 28, 28)');
    await page.screenshot({ path: `${SHOTS}/widget-validation.png` });

    const text = `Checkout total doesn't update after removing an item ${uniqueSuffix()}`;
    await description.fill(text);
    await email.fill('jane@example.test');
    await page.getByRole('combobox', { name: 'Severity' }).selectOption('major');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.locator('#pinpoint-description-error')).toHaveCount(0);
    const status = page.getByRole('status');
    await expect(status).toContainText('Thank you!');
    // Success state: a real heading plus a decorative (aria-hidden) check icon.
    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
    await expect(page.locator('svg.pinpoint-success-icon[aria-hidden="true"]')).toBeVisible();
    await expect(status).toContainText('Your feedback has been submitted.');
    await page.waitForTimeout(250);
    expect(await widgetFocus(page)).toBe('pinpoint-close');
    await page.screenshot({ path: `${SHOTS}/widget-success.png` });

    await expect
      .poll(async () => (await listAnnotations(api!, project!.id)).length, { timeout: 10_000, intervals: [1_000] })
      .toBeGreaterThanOrEqual(1);

    // Auto-closes and returns focus to the trigger.
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5_000 });
    expect(await widgetFocus(page)).toContain('pinpoint-trigger');
    await page.context().close();
  });

  test('error state when the API rejects the origin keeps the text for a retry', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${BLOCKED_ORIGIN}/`);
    await page.locator('#pinpoint-widget-host .pinpoint-trigger').click();
    const description = page.getByRole('textbox', { name: 'Description' });
    await description.fill('Plant care page 404s');
    await page.getByRole('button', { name: 'Submit' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Submission failed');
    await expect(alert).toContainText("couldn't reach the feedback service");
    await expect(alert).not.toContainText('Failed to fetch');
    await expect(description).toHaveValue('Plant care page 404s');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/widget-error.png` });
    await page.context().close();
  });

  test('mobile 390×844: bottom sheet, full width, trigger never covers the dialog', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${OK_ORIGIN}/`, { width: 390, height: 844 });
    const trigger = page.locator('#pinpoint-widget-host .pinpoint-trigger');
    const tb = (await trigger.boundingBox())!;
    expect(Math.round(390 - (tb.x + tb.width))).toBe(20);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dialog).toBeVisible();
    // Wait out the slide-up animation before measuring.
    await expect
      .poll(async () => {
        const b = await dialog.boundingBox();
        return b ? `${Math.round(b.width)}x${Math.round(b.y + b.height)}` : '';
      })
      .toBe('390x844');
    await page.waitForTimeout(100);
    // Nothing clipped horizontally; every control is inside the viewport.
    for (const name of ['Cancel', 'Submit']) {
      const b = (await page.getByRole('button', { name }).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }
    // The floating trigger is underneath the overlay, not on top of the sheet.
    const topAtTrigger = await page.evaluate(
      ([x, y]) => {
        const root = document.getElementById('pinpoint-widget-host')!.shadowRoot!;
        const el = root.elementFromPoint(x, y) as HTMLElement | null;
        return el?.className ?? '';
      },
      [tb.x + tb.width / 2, tb.y + tb.height / 2],
    );
    expect(topAtTrigger).not.toContain('pinpoint-trigger');
    await page.screenshot({ path: `${SHOTS}/widget-open-mobile.png` });
    await page.context().close();
  });

  test('axe: no critical/serious violations from the widget with the form open', async ({ browser }) => {
    test.skip(!api, 'Seed session unavailable.');
    const page = await openPage(browser, `${OK_ORIGIN}/`);
    await page.locator('#pinpoint-widget-host .pinpoint-trigger').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // Let the open animation finish so colour-contrast sees final colours.
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const fromWidget = serious
      .map((v) => ({
        id: v.id,
        nodes: v.nodes.filter((n) => JSON.stringify(n.target).includes('pinpoint-widget-host')).map((n) => n.target),
      }))
      .filter((v) => v.nodes.length > 0);
    test.info().annotations.push({
      type: 'axe',
      description: `violations: ${results.violations.map((v) => `${v.id}(${v.impact}, ${v.nodes.length})`).join(', ') || 'none'}`,
    });
    expect(fromWidget, JSON.stringify(fromWidget, null, 2)).toEqual([]);

    // Same check on the success state.
    await page.getByRole('textbox', { name: 'Description' }).fill(`axe success ${uniqueSuffix()}`);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('status')).toContainText('Thank you!');
    await page.waitForTimeout(300);
    const after = await new AxeBuilder({ page }).include('#pinpoint-widget-host').analyze();
    const afterSerious = after.violations
      .filter((v) => v.impact === 'critical' || v.impact === 'serious')
      .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ t: n.target, s: n.failureSummary })) }));
    expect(afterSerious, JSON.stringify(afterSerious, null, 2)).toEqual([]);
    await page.context().close();
  });
});
