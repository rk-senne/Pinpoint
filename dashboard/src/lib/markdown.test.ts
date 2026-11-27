// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderInline, renderMarkdown, slugify } from './markdown';

function html(md: string): string {
  const host = document.createElement('div');
  host.appendChild(renderMarkdown(md));
  return host.innerHTML;
}

describe('renderMarkdown', () => {
  it('renders headings with stable, de-duplicated ids', () => {
    const host = document.createElement('div');
    host.appendChild(renderMarkdown('# Title\n\n## Data we collect\n\n## Data we collect'));
    expect([...host.querySelectorAll('h1,h2')].map((h) => `${h.tagName}#${h.id}`)).toEqual([
      'H1#title', 'H2#data-we-collect', 'H2#data-we-collect-1',
    ]);
    expect(slugify('9. Cookies & "storage"!')).toBe('9-cookies-storage');
  });

  it('renders paragraphs (joining wrapped lines), bold, italic and code', () => {
    expect(html('Hello **bold** and *it* and `a<b` x\nsecond line')).toBe(
      '<p>Hello <strong>bold</strong> and <em>it</em> and <code>a&lt;b</code> x second line</p>',
    );
  });

  it('renders bullet, numbered and nested lists', () => {
    const h = html('- one\n- two\n  - nested\n  - nested2\n- three\n\n1. a\n2. b');
    expect(h).toContain('<ul><li>one</li><li>two<ul><li>nested</li><li>nested2</li></ul></li><li>three</li></ul>');
    expect(h).toContain('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders pipe tables with inline markup in cells', () => {
    const h = html('| Name | Purpose |\n|---|---|\n| `fl_session` | **auth** |\n| b | c |');
    expect(h).toContain('<th>Name</th><th>Purpose</th>');
    expect(h).toContain('<td><code>fl_session</code></td><td><strong>auth</strong></td>');
    expect(h.match(/<tr>/g)).toHaveLength(3);
  });

  it('renders blockquotes, rules and fenced code, and drops HTML comments', () => {
    const h = html('> **Note** careful\n\n---\n\n```\nline <1>\nline 2\n```\n\n<!-- hidden -->after');
    expect(h).toContain('<blockquote><p><strong>Note</strong> careful</p></blockquote>');
    expect(h).toContain('<hr>');
    expect(h).toContain('<pre><code>line &lt;1&gt;\nline 2</code></pre>');
    expect(h).not.toContain('hidden');
    expect(h).toContain('<p>after</p>');
  });

  it('NEVER turns markdown into markup (XSS): tags, handlers and javascript: links stay inert', () => {
    const host = document.createElement('div');
    host.appendChild(
      renderMarkdown(
        [
          '<script>window.__pwned = 1</script>',
          '<img src=x onerror="window.__pwned = 2">',
          '[click](javascript:window.__pwned=3) [data](data:text/html,<b>x</b>) [ok](https://example.com/a?b=1)',
          '# <b>head</b>',
          '| <i>a</i> |\n|---|\n| <u>b</u> |',
        ].join('\n\n'),
      ),
    );
    expect(host.querySelector('script, img, b, i, u')).toBeNull();
    expect(host.textContent).toContain('<script>window.__pwned = 1</script>');
    const anchors = [...host.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(anchors[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.textContent).toContain('click');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('maps links to other legal documents onto in-app routes and drops unknown relative links', () => {
    const p = document.createElement('p');
    renderInline('[PP](./PRIVACY_POLICY.md#cookies) [x](../../server/src/a.ts) [m](mailto:privacy@example.com) [top](#intro)', p);
    const a = [...p.querySelectorAll('a')];
    expect(a.map((x) => x.getAttribute('href'))).toEqual(['/legal/privacy#cookies', 'mailto:privacy@example.com', '#intro']);
    expect(a[0]!.hasAttribute('data-route')).toBe(true);
    expect(p.textContent).toContain('x');
    expect(p.innerHTML).not.toContain('server/src');
  });

  it('handles empty input', () => {
    expect(html('')).toBe('');
  });
});

describe('renderMarkdown comment stripping', () => {
  it('removes nested/overlapping HTML comments completely (no "<!--" debris)', () => {
    const frag = renderMarkdown('Hello <!<!---->-- hidden --> world');
    const text = frag.textContent ?? '';
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('hidden');
  });
});
