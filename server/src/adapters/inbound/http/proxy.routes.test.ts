import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import {
  createProxyRoutes,
  injectIntoHtml,
  type ProxyFetchResponse,
  type ProxySafeFetch,
} from './proxy.routes.js';
import { reviewOverlayScript } from './reviewOverlay.js';
import { FakeSharedLinkRepo } from '../../../__tests__/fakes/FakeSharedLinkRepo.js';
import { FakePageRepo } from '../../../__tests__/fakes/FakePageRepo.js';
import { FakeClock } from '../../../__tests__/fakes/FakeClock.js';
import { EgressBlockedError } from '../../../services/egressGuard.js';

const PROJECT_ID = 'b0000000-0000-4000-8000-000000000001';
const OPEN_LINK = 'open-link-128bit-token';
const TARGET = 'https://example.com/pricing';

function htmlResponse(
  html: string,
  { status = 200, contentType = 'text/html; charset=utf-8', location, contentLength }: {
    status?: number;
    contentType?: string | null;
    location?: string;
    contentLength?: string;
  } = {},
): ProxyFetchResponse {
  const map = new Map<string, string>();
  if (contentType !== null) map.set('content-type', contentType);
  if (location) map.set('location', location);
  if (contentLength) map.set('content-length', contentLength);
  return {
    status,
    headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null },
    text: async () => html,
    // Real streamed body, as undici provides — exercises the capped read path.
    body: new Response(html).body,
  };
}

async function setup(opts: {
  allowFeedback?: boolean;
  passwordHash?: string | null;
  pages?: string[];
  safeFetchImpl?: ProxySafeFetch;
  frameAncestors?: string[];
  assertPublicUrlImpl?: (url: string) => Promise<unknown>;
  linkId?: string;
}) {
  const clock = new FakeClock();
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);
  const pageRepo = new FakePageRepo(clock);

  const linkId = opts.linkId ?? OPEN_LINK;
  await sharedLinkRepo.insert({
    id: linkId,
    projectId: PROJECT_ID,
    passwordHash: opts.passwordHash ?? null,
    allowFeedback: opts.allowFeedback ?? true,
  });
  for (const url of opts.pages ?? [TARGET]) {
    await pageRepo.insert({ projectId: PROJECT_ID, url, title: null });
  }

  const app = express();
  // Mirror production: the global security middleware forbids all framing.
  app.use((_req, res, next) => { res.setHeader('X-Frame-Options', 'DENY'); next(); });
  app.use(
    '/review',
    createProxyRoutes({
      ...(opts.frameAncestors ? { frameAncestors: opts.frameAncestors } : {}),
      sharedLinkRepo,
      pageRepo,
      ...(opts.safeFetchImpl ? { safeFetchImpl: opts.safeFetchImpl } : {}),
      ...(opts.assertPublicUrlImpl
        ? { assertPublicUrlImpl: opts.assertPublicUrlImpl as never }
        : {}),
    }),
  );
  return { app, sharedLinkRepo, pageRepo };
}

describe('injectIntoHtml', () => {
  it('injects <base>, noindex meta, and the overlay script', () => {
    const out = injectIntoHtml(
      '<html><head><title>T</title></head><body><h1>hi</h1></body></html>',
      'https://example.com/',
      OPEN_LINK,
    );
    expect(out).toContain('<base href="https://example.com/">');
    expect(out).toContain('<meta name="robots" content="noindex">');
    expect(out).toContain('data-pinpoint-review');
    // Base comes before the overlay (overlay sits before </body>).
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('data-pinpoint-review'));
  });

  it('escapes the origin in the base href attribute', () => {
    const out = injectIntoHtml('<head></head>', 'https://e"x<a>mple.com/', OPEN_LINK);
    expect(out).toContain('&quot;');
    expect(out).not.toContain('href="https://e"x');
  });

  it('synthesizes a head when none exists', () => {
    const out = injectIntoHtml('<body>x</body>', 'https://example.com/', OPEN_LINK);
    expect(out.startsWith('<head>')).toBe(true);
    expect(out).toContain('<base href="https://example.com/">');
  });
});

describe('reviewOverlayScript', () => {
  it('embeds the linkId as a JSON literal', () => {
    const s = reviewOverlayScript('abc"def');
    expect(s).toContain('"abc\\"def"');
  });

  it('delivers feedback via postMessage to the parent, never via fetch/API URL', () => {
    const s = reviewOverlayScript('abc');
    expect(s).toContain('window.parent.postMessage');
    expect(s).toContain('pinpoint:review-feedback');
    // Only accepts results from the parent window.
    expect(s).toContain('ev.source !== window.parent');
    expect(s).not.toContain('fetch(');
    expect(s).not.toContain('/api/v1/');
  });
});

describe('proxy.routes — GET /review/:linkId', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('happy path: injects base + overlay, strict CSP, 200', async () => {
    const safeFetchImpl = vi.fn(async () =>
      htmlResponse('<html><head></head><body>real site</body></html>'),
    );
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<base href="https://example.com/">');
    expect(res.text).toContain('data-pinpoint-review');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(safeFetchImpl).toHaveBeenCalledTimes(1);
  });

  it('CSP sandboxes the proxied document into an opaque origin (no allow-same-origin)', async () => {
    const safeFetchImpl = vi.fn(async () =>
      htmlResponse('<html><head></head><body><script>steal()</script></body></html>'),
    );
    const { app } = await setup({ safeFetchImpl });
    for (const path of [`/review/${OPEN_LINK}`, `/review/${OPEN_LINK}/frame`]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      const csp = res.headers['content-security-policy'] as string;
      const sandbox = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('sandbox'));
      expect(sandbox).toBe('sandbox allow-scripts allow-forms allow-popups');
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).not.toContain('allow-top-navigation');
    }
  });

  it('non-html content is rejected (415)', async () => {
    const safeFetchImpl = vi.fn(async () =>
      htmlResponse('{}', { contentType: 'application/json' }),
    );
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_CONTENT');
  });

  it('oversize page is rejected (413) via declared content-length', async () => {
    const safeFetchImpl = vi.fn(async () =>
      htmlResponse('<html></html>', { contentLength: String(6 * 1024 * 1024) }),
    );
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('TOO_LARGE');
  });

  it('oversize page is rejected (413) via actual body length', async () => {
    const big = '<html><head></head><body>' + 'x'.repeat(6 * 1024 * 1024) + '</body></html>';
    const safeFetchImpl = vi.fn(async () => htmlResponse(big));
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(413);
  });

  it('private-IP target is rejected (502 EGRESS_BLOCKED)', async () => {
    const assertPublicUrlImpl = vi.fn(async () => {
      throw new EgressBlockedError('Blocked IP address: 169.254.169.254');
    });
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html></html>'));
    const { app } = await setup({ safeFetchImpl, assertPublicUrlImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EGRESS_BLOCKED');
    expect(safeFetchImpl).not.toHaveBeenCalled();
  });

  it('missing link and feedback-disabled link return identical 404', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html></html>'));

    const { app: appMissing } = await setup({ safeFetchImpl });
    const missing = await request(appMissing).get('/review/does-not-exist');

    const { app: appDisabled } = await setup({
      safeFetchImpl,
      allowFeedback: false,
      linkId: 'disabled-link',
    });
    const disabled = await request(appDisabled).get('/review/disabled-link');

    expect(missing.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(missing.text).toBe(disabled.text);
    expect(safeFetchImpl).not.toHaveBeenCalled();
  });

  it('password-protected link returns 401 PASSWORD_REQUIRED (no fetch)', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html></html>'));
    const { app } = await setup({ safeFetchImpl, passwordHash: 'bcrypt$hash' });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PASSWORD_REQUIRED');
    expect(safeFetchImpl).not.toHaveBeenCalled();
  });

  it('redirects are followed and EACH hop re-validated', async () => {
    const seen: string[] = [];
    const assertPublicUrlImpl = vi.fn(async (url: string) => {
      seen.push(url);
    });
    const safeFetchImpl = vi.fn(async (url: string) => {
      if (url === TARGET) {
        return htmlResponse('', { status: 302, location: 'https://cdn.example.com/final' });
      }
      return htmlResponse('<html><head></head><body>final</body></html>');
    });
    const { app } = await setup({ safeFetchImpl, assertPublicUrlImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(200);
    // Both the original and the redirect target were validated.
    expect(seen).toContain(TARGET);
    expect(seen).toContain('https://cdn.example.com/final');
    expect(res.text).toContain('<base href="https://cdn.example.com/">');
  });

  it('a redirect to a private host is rejected on re-validation (502)', async () => {
    const assertPublicUrlImpl = vi.fn(async (url: string) => {
      if (url.includes('169.254')) throw new EgressBlockedError('blocked');
    });
    const safeFetchImpl = vi.fn(async () =>
      htmlResponse('', { status: 302, location: 'http://169.254.169.254/' }),
    );
    const { app } = await setup({ safeFetchImpl, assertPublicUrlImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EGRESS_BLOCKED');
  });

  it('too many redirects is rejected (502)', async () => {
    const safeFetchImpl = vi.fn(async (url: string) =>
      htmlResponse('', { status: 302, location: url + '/x' }),
    );
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EGRESS_BLOCKED');
  });

  it('upstream non-2xx (final) returns 502 UPSTREAM_ERROR', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('nope', { status: 500 }));
    const { app } = await setup({ safeFetchImpl });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it('project with no target page returns 404', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html></html>'));
    const { app } = await setup({ safeFetchImpl, pages: [] });
    const res = await request(app).get(`/review/${OPEN_LINK}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('proxy.routes — /review/:linkId/frame (iframe path)', () => {
  it('serves the same proxied document as /review/:linkId', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html><head></head><body>hi</body></html>'));
    const { app } = await setup({ safeFetchImpl });
    const viaFrame = await request(app).get(`/review/${OPEN_LINK}/frame`);
    expect(viaFrame.status).toBe(200);
    expect(viaFrame.text).toContain('<base href');
  });
});

describe('proxy.routes — framing by the dashboard', () => {
  it('lets the configured dashboard origin frame the proxied page (and nobody else)', async () => {
    const safeFetchImpl = vi.fn(async () => htmlResponse('<html><head></head><body>hi</body></html>'));
    const { app } = await setup({ safeFetchImpl, frameAncestors: ['https://app.pinpoint.test'] });
    const res = await request(app).get(`/review/${OPEN_LINK}/frame`);
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self' https://app.pinpoint.test");
  });

  it('error pages (unknown link) are framable too, so the frame shows the message', async () => {
    const { app } = await setup({ frameAncestors: ['https://app.pinpoint.test'] });
    const res = await request(app).get('/review/does-not-exist/frame');
    expect(res.status).toBe(404);
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' https://app.pinpoint.test; sandbox allow-scripts allow-forms allow-popups",
    );
  });

  it('drops malformed ancestor values (no CSP directive injection)', async () => {
    const { app } = await setup({ frameAncestors: ['https://ok.test; script-src *', 'javascript:alert(1)'] });
    const res = await request(app).get('/review/does-not-exist/frame');
    expect(res.headers['content-security-policy']).toBe(
      "frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups",
    );
  });
});

