// @vitest-environment jsdom
/**
 * safeText.test.ts — proves the shared DOM helpers neutralise markup
 * injection (Mission B1). The headline guarantee: untrusted payloads such as
 * `<img src=x onerror=alert(1)>` and `<script>…</script>` render as inert,
 * visible text and never become live DOM.
 */

import { describe, it, expect } from 'vitest';
import { setText, el, escapeHtml, isSafeUrl } from './safeText.js';

const IMG_PAYLOAD = '<img src=x onerror=alert(1)>';
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';

describe('setText', () => {
  it('renders a script payload as inert text, not an element', () => {
    const div = document.createElement('div');
    setText(div, SCRIPT_PAYLOAD);
    expect(div.textContent).toBe(SCRIPT_PAYLOAD);
    expect(div.querySelector('script')).toBeNull();
    expect(div.children.length).toBe(0);
  });

  it('renders an img/onerror payload as inert text', () => {
    const div = document.createElement('div');
    setText(div, IMG_PAYLOAD);
    expect(div.textContent).toBe(IMG_PAYLOAD);
    expect(div.querySelector('img')).toBeNull();
    expect(div.children.length).toBe(0);
  });

  it('coerces numbers to text', () => {
    const span = document.createElement('span');
    setText(span, 42);
    expect(span.textContent).toBe('42');
  });
});

describe('el', () => {
  it('appends string children as text nodes (no HTML parsing)', () => {
    const node = el('span', {}, IMG_PAYLOAD);
    expect(node.tagName).toBe('SPAN');
    expect(node.textContent).toBe(IMG_PAYLOAD);
    expect(node.querySelector('img')).toBeNull();
    expect(node.children.length).toBe(0);
  });

  it('sets allow-listed attributes', () => {
    const node = el('button', { id: 'b1', 'aria-label': 'Save', type: 'submit' }, 'Save');
    expect(node.getAttribute('id')).toBe('b1');
    expect(node.getAttribute('aria-label')).toBe('Save');
    expect(node.getAttribute('type')).toBe('submit');
    expect(node.textContent).toBe('Save');
  });

  it('drops event-handler and style attributes from untrusted input', () => {
    const node = el('div', {
      onclick: 'alert(1)',
      onerror: 'alert(1)',
      style: 'background:url(javascript:alert(1))',
    } as Record<string, string>);
    expect(node.getAttribute('onclick')).toBeNull();
    expect(node.getAttribute('onerror')).toBeNull();
    expect(node.getAttribute('style')).toBeNull();
  });

  it('drops javascript: URLs on href/src but keeps http(s) ones', () => {
    const bad = el('a', { href: 'javascript:alert(1)' }, 'x');
    expect(bad.getAttribute('href')).toBeNull();

    const ok = el('a', { href: 'https://example.com/path' }, 'x');
    expect(ok.getAttribute('href')).toBe('https://example.com/path');

    const rel = el('a', { href: '/dashboard' }, 'x');
    expect(rel.getAttribute('href')).toBe('/dashboard');
  });

  it('handles boolean attributes and skips nullish ones', () => {
    const node = el('input', { disabled: true, required: false, placeholder: undefined });
    expect(node.hasAttribute('disabled')).toBe(true);
    expect(node.hasAttribute('required')).toBe(false);
    expect(node.hasAttribute('placeholder')).toBe(false);
  });

  it('skips falsy children and appends node children as-is', () => {
    const inner = el('strong', {}, 'bold');
    const node = el('span', {}, [inner, null, false, undefined, ' tail']);
    expect(node.childNodes.length).toBe(2);
    expect(node.querySelector('strong')?.textContent).toBe('bold');
    expect(node.textContent).toBe('bold tail');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(SCRIPT_PAYLOAD)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`"&'<>`)).toBe('&quot;&amp;&#39;&lt;&gt;');
  });

  it('is inert when re-parsed as markup', () => {
    const div = document.createElement('div');
    // Simulate a (discouraged) string-template sink; escaped output must not
    // produce live elements.
    div.innerHTML = escapeHtml(IMG_PAYLOAD);
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toBe(IMG_PAYLOAD);
  });
});

describe('isSafeUrl', () => {
  it('allows http, https, mailto, relative, and fragment URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('mailto:a@b.com')).toBe(true);
    expect(isSafeUrl('/path')).toBe(true);
    expect(isSafeUrl('#anchor')).toBe(true);
    expect(isSafeUrl('?q=1')).toBe(true);
    expect(isSafeUrl('example.com/path')).toBe(true);
  });

  it('rejects dangerous schemes and empty input', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
  });
});
