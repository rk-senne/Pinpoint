/**
 * LegalPage — public, unauthenticated legal documents.
 *
 *   /legal            index of documents
 *   /legal/:doc       one document (terms, privacy, cookies, subprocessors, dpa,
 *                     acceptable-use, retention, breach-response)
 *
 * The Markdown comes from `docs/legal/*.md`, bundled at build time with Vite's
 * `?raw` import (single source of truth — edit the Markdown, rebuild) and
 * rendered with `lib/markdown.ts`, which builds DOM nodes only (no innerHTML),
 * so document text can never become markup.
 *
 * The page makes no API calls and sets no cookies/storage.
 */

import { el, setText } from '@pinpoint/shared';

import { registerTemplates } from '../lib/lazyTemplates';
import { renderMarkdown } from '../lib/markdown';
import { bindEvents, cloneTemplate, mount, requireSlot } from '../lib/render';
import templatesHtml from './LegalPage.templates.html?raw';

import terms from '../../../docs/legal/TERMS_OF_SERVICE.md?raw';
import privacy from '../../../docs/legal/PRIVACY_POLICY.md?raw';
import cookies from '../../../docs/legal/COOKIE_POLICY.md?raw';
import subprocessors from '../../../docs/legal/SUBPROCESSORS.md?raw';
import dpa from '../../../docs/legal/DATA_PROCESSING_AGREEMENT.md?raw';
import acceptableUse from '../../../docs/legal/ACCEPTABLE_USE_POLICY.md?raw';
import retention from '../../../docs/legal/DATA_RETENTION.md?raw';
import breachResponse from '../../../docs/legal/BREACH_RESPONSE.md?raw';

export interface LegalDoc {
  slug: string;
  title: string;
  /** Short label for the footer / nav. */
  label: string;
  markdown: string;
}

export const LEGAL_DOCS: readonly LegalDoc[] = [
  { slug: 'terms', title: 'Terms of Service', label: 'Terms', markdown: terms },
  { slug: 'privacy', title: 'Privacy Policy', label: 'Privacy', markdown: privacy },
  { slug: 'cookies', title: 'Cookie Policy', label: 'Cookies', markdown: cookies },
  { slug: 'subprocessors', title: 'Sub-processors', label: 'Sub-processors', markdown: subprocessors },
  { slug: 'dpa', title: 'Data Processing Agreement', label: 'DPA', markdown: dpa },
  { slug: 'acceptable-use', title: 'Acceptable Use Policy', label: 'Acceptable use', markdown: acceptableUse },
  { slug: 'retention', title: 'Data Retention', label: 'Retention', markdown: retention },
  { slug: 'breach-response', title: 'Breach Response', label: 'Breach response', markdown: breachResponse },
];

export function findLegalDoc(slug: string | undefined): LegalDoc | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

/** True while a document still contains unfilled `{{PLACEHOLDER}}` tokens. */
export function hasPlaceholders(markdown: string): boolean {
  return /\{\{[A-Z_]+\}\}/.test(markdown);
}

export function mountLegalPage(rootEl: HTMLElement, params?: Record<string, string>): () => void {
  registerTemplates('legal-page', templatesHtml);
  const fragment = cloneTemplate('tpl-legal-page');
  const pageRoot = fragment.firstElementChild as HTMLElement | null;
  if (!pageRoot) throw new Error('mountLegalPage: #tpl-legal-page template is empty');

  const slug = params?.doc;
  const doc = findLegalDoc(slug);
  const previousTitle = document.title;

  // Navigation between documents.
  const nav = requireSlot(pageRoot, 'nav');
  for (const d of LEGAL_DOCS) {
    const a = el('a', { href: `/legal/${d.slug}` }, d.label);
    a.setAttribute('data-route', '');
    a.style.color = 'var(--pp-link-alt)';
    if (d.slug === doc?.slug) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }

  const content = requireSlot(pageRoot, 'content');
  const banner = requireSlot(pageRoot, 'draft-banner');

  if (doc) {
    document.title = `${doc.title} — Pinpoint`;
    content.appendChild(renderMarkdown(doc.markdown));
    if (hasPlaceholders(doc.markdown)) {
      setText(banner, 'Draft: this document still contains unfilled {{PLACEHOLDER}} values and has not been reviewed by a lawyer.');
      banner.hidden = false;
    }
  } else if (slug === undefined) {
    document.title = 'Legal — Pinpoint';
    content.appendChild(el('h1', {}, 'Legal'));
    content.appendChild(
      el(
        'ul',
        {},
        LEGAL_DOCS.map((d) => {
          const a = el('a', { href: `/legal/${d.slug}` }, d.title);
          a.setAttribute('data-route', '');
          return el('li', {}, a);
        }),
      ),
    );
  } else {
    document.title = 'Document not found — Pinpoint';
    content.appendChild(el('h1', {}, 'Document not found'));
    content.appendChild(el('p', {}, 'That legal document does not exist. Choose one from the menu above.'));
  }

  const cleanupEvents = bindEvents(pageRoot, {});
  mount(rootEl, fragment);

  // Jump to a #fragment once the content is in the DOM.
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const target = Array.from(content.querySelectorAll('[id]')).find((n) => n.id === hash);
    target?.scrollIntoView?.();
  }

  return () => {
    cleanupEvents();
    document.title = previousTitle;
    pageRoot.remove();
  };
}
