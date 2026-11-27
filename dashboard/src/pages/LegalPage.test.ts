// @vitest-environment jsdom
/**
 * LegalPage — renders the bundled docs/legal/*.md without innerHTML, keeps
 * every cross-document link resolvable and every claim in the Cookie Policy
 * in step with the server's real cookie names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetLazyTemplatesForTests } from '../lib/lazyTemplates';
import { LEGAL_FILE_SLUGS } from '../lib/markdown';
import sessionCookiesSrc from '../../../server/src/middleware/sessionCookies.ts?raw';
import sharedLinkAccessSrc from '../../../server/src/adapters/inbound/http/sharedLinkAccess.ts?raw';
import oauthRoutesSrc from '../../../server/src/adapters/inbound/http/oauth.routes.ts?raw';
import integrationsRoutesSrc from '../../../server/src/adapters/inbound/http/integrations.routes.ts?raw';
import cookiePolicy from '../../../docs/legal/COOKIE_POLICY.md?raw';
import legalPageSrc from './LegalPage.ts?raw';
import markdownSrc from '../lib/markdown.ts?raw';
import { LEGAL_DOCS, findLegalDoc, hasPlaceholders, mountLegalPage } from './LegalPage';

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  _resetLazyTemplatesForTests();
  document.title = 'Pinpoint';
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('mountLegalPage', () => {
  it('renders every bundled document with a heading, the nav and no leftover markdown syntax', () => {
    for (const d of LEGAL_DOCS) {
      host.textContent = '';
      const teardown = mountLegalPage(host, { doc: d.slug });
      const content = host.querySelector('[data-slot="content"]')!;
      expect(content.querySelector('h1'), d.slug).not.toBeNull();
      expect(host.querySelectorAll('nav a')).toHaveLength(LEGAL_DOCS.length);
      expect(host.querySelector('nav a[aria-current="page"]')!.getAttribute('href')).toBe(`/legal/${d.slug}`);
      expect(document.title).toBe(`${d.title} — Pinpoint`);
      const text = content.textContent ?? '';
      expect(text, `${d.slug} leaks bold markers`).not.toMatch(/\*\*/);
      expect(text, `${d.slug} leaks table pipes`).not.toMatch(/^\s*\|[-\s|]+\|\s*$/m);
      expect(content.querySelector('script, iframe, img, style')).toBeNull();
      teardown();
      expect(document.title).toBe('Pinpoint');
      expect(host.querySelector('[data-role="legal-root"]')).toBeNull();
    }
  });

  it('every in-app link in every document resolves to a real route or heading', () => {
    for (const d of LEGAL_DOCS) {
      host.textContent = '';
      mountLegalPage(host, { doc: d.slug });
      const ids = new Set(Array.from(host.querySelectorAll('[id]')).map((n) => n.id));
      for (const a of Array.from(host.querySelectorAll<HTMLAnchorElement>('article a'))) {
        const href = a.getAttribute('href')!;
        if (href.startsWith('/legal/')) {
          const [path, frag] = href.split('#');
          const target = findLegalDoc(path!.replace('/legal/', ''));
          expect(target, `${d.slug}: dead link ${href}`).toBeDefined();
          if (frag) {
            host.textContent = '';
            mountLegalPage(host, { doc: target!.slug });
            const tIds = new Set(Array.from(host.querySelectorAll('[id]')).map((n) => n.id));
            expect(tIds.has(frag), `${d.slug}: missing anchor ${href}`).toBe(true);
            host.textContent = '';
            mountLegalPage(host, { doc: d.slug });
          }
        } else if (href.startsWith('#')) {
          expect(ids.has(href.slice(1)), `${d.slug}: missing anchor ${href}`).toBe(true);
        } else {
          expect(href, `${d.slug}: unexpected link`).toMatch(/^(https?:|mailto:)/);
        }
      }
    }
  });

  it('only references legal documents that exist in docs/legal (source files)', () => {
    for (const d of LEGAL_DOCS) {
      for (const m of d.markdown.matchAll(/\]\(\.\/([A-Z_]+\.md)(?:#[^)]*)?\)/g)) {
        expect(LEGAL_FILE_SLUGS[m[1]!], `${d.slug} links ./${m[1]}`).toBeDefined();
      }
    }
    // …and every document is reachable through the slug table.
    expect(new Set(Object.values(LEGAL_FILE_SLUGS))).toEqual(new Set(LEGAL_DOCS.map((d) => d.slug)));
  });

  it('shows a draft banner while placeholders remain, and the index and not-found views', () => {
    mountLegalPage(host, { doc: 'privacy' });
    const banner = host.querySelector<HTMLElement>('[data-slot="draft-banner"]')!;
    expect(hasPlaceholders(findLegalDoc('privacy')!.markdown)).toBe(true);
    expect(banner.hidden).toBe(false);

    host.textContent = '';
    mountLegalPage(host, {});
    expect(host.querySelectorAll('article li a')).toHaveLength(LEGAL_DOCS.length);

    host.textContent = '';
    mountLegalPage(host, { doc: 'nope' });
    expect(host.querySelector('article h1')!.textContent).toBe('Document not found');
  });

  it('the Cookie Policy lists every cookie the server really sets', () => {
    expect(sessionCookiesSrc).toContain("SESSION_COOKIE = 'fl_session'");
    expect(sessionCookiesSrc).toContain("CSRF_COOKIE = 'fl_csrf'");
    expect(sessionCookiesSrc).toContain('24 * 60 * 60');
    expect(sharedLinkAccessSrc).toContain("'fl_shared_access'");
    expect(sharedLinkAccessSrc).toContain('30 * 60');
    expect(oauthRoutesSrc).toContain("STATE_COOKIE = 'oauth_state'");
    expect(integrationsRoutesSrc).toContain("'integration_oauth_state'");
    for (const name of ['__Host-fl_session', '__Host-fl_csrf', 'fl_shared_access', 'oauth_state', 'integration_oauth_state', 'pinpoint_theme']) {
      expect(cookiePolicy, name).toContain(name);
    }
    // Lifetimes quoted in the policy match the code constants.
    expect(cookiePolicy).toMatch(/24 hours/);
    expect(cookiePolicy).toMatch(/30 minutes/);
    expect(cookiePolicy).toMatch(/10 minutes/);
  });

  it('never uses innerHTML-style sinks (the page is built from DOM nodes only)', () => {
    expect(legalPageSrc + markdownSrc).not.toMatch(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/);
  });
});
