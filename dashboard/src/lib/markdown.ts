/**
 * Tiny, SAFE markdown → DOM renderer for the bundled legal documents.
 *
 * It builds real DOM nodes with `el()` / text nodes only — it never parses or
 * assigns HTML — so markdown text can never become markup, even if a document
 * contained `<script>` or `<img onerror>` (they render as literal text).
 *
 * Supported subset (everything the legal markdown files use):
 *   block:  # … ###### headings, paragraphs, dash or asterisk bullets and `1.` lists
 *           (one nesting level by 2+ space indent), > blockquotes, ``` fenced
 *           code, --- rules, pipe tables, HTML comments (dropped)
 *   inline: **bold**, single-star or underscore italics, `code`, [text](url)
 *
 * Links: `http(s):`/`mailto:` open normally (`rel=noopener noreferrer`); a
 * relative link to another legal document (`./PRIVACY_POLICY.md#x`) is turned
 * into the in-app `/legal/<slug>` route; any other relative link renders as
 * plain text (the dashboard cannot serve repo files).
 */

import { el, isSafeUrl } from '@pinpoint/shared';

/** Map of repo file name → in-app slug (see pages/LegalPage.ts). */
export const LEGAL_FILE_SLUGS: Readonly<Record<string, string>> = {
  'TERMS_OF_SERVICE.md': 'terms',
  'PRIVACY_POLICY.md': 'privacy',
  'COOKIE_POLICY.md': 'cookies',
  'SUBPROCESSORS.md': 'subprocessors',
  'DATA_PROCESSING_AGREEMENT.md': 'dpa',
  'ACCEPTABLE_USE_POLICY.md': 'acceptable-use',
  'DATA_RETENTION.md': 'retention',
  'BREACH_RESPONSE.md': 'breach-response',
};

function resolveHref(raw: string): { href: string; external: boolean; internal: boolean } | null {
  const url = raw.trim();
  if (/^(https?:|mailto:)/i.test(url)) return isSafeUrl(url) ? { href: url, external: !/^mailto:/i.test(url), internal: false } : null;
  const m = /^(?:\.\/)?([A-Z_]+\.md)(#[A-Za-z0-9_-]+)?$/.exec(url);
  if (m) {
    const slug = LEGAL_FILE_SLUGS[m[1]!];
    if (slug) return { href: `/legal/${slug}${m[2] ?? ''}`, external: false, internal: true };
  }
  if (url.startsWith('#')) return { href: url, external: false, internal: false };
  return null;
}

/** Render inline markdown into `parent`. */
export function renderInline(src: string, parent: Node): void {
  let rest = src;
  // Order matters: code first (its content is literal), then links, then emphasis.
  const re = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)|(\b_([^_\s][^_]*)_\b)/;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) {
      parent.appendChild(document.createTextNode(rest));
      return;
    }
    if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
    if (m[1]) {
      parent.appendChild(el('code', {}, m[1].slice(1, -1)));
    } else if (m[2]) {
      const target = resolveHref(m[4]!);
      if (target) {
        const a = el('a', { href: target.href });
        if (target.external) a.setAttribute('rel', 'noopener noreferrer');
        if (target.internal) a.setAttribute('data-route', '');
        renderInline(m[3]!, a);
        parent.appendChild(a);
      } else {
        renderInline(m[3]!, parent);
      }
    } else if (m[5]) {
      const b = el('strong');
      renderInline(m[6]!, b);
      parent.appendChild(b);
    } else if (m[7]) {
      const i = el('em');
      renderInline(m[8]!, i);
      parent.appendChild(i);
    } else if (m[9]) {
      const i = el('em');
      renderInline(m[10]!, i);
      parent.appendChild(i);
    }
    rest = rest.slice(m.index + m[0].length);
  }
}

/** URL-fragment id for a heading (GitHub-style, ASCII). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l: string): string[] =>
  l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** Render a whole markdown document to a fragment. */
export function renderMarkdown(markdown: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const src = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const usedIds = new Map<string, number>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^\s*$/.test(line)) { i += 1; continue; }

    // Fenced code.
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) { buf.push(lines[i]!); i += 1; }
      i += 1;
      out.appendChild(el('pre', {}, el('code', {}, buf.join('\n'))));
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const node = el(`h${level}` as 'h1', {});
      renderInline(h[2]!, node);
      const base = slugify(h[2]!) || 'section';
      const n = usedIds.get(base) ?? 0;
      usedIds.set(base, n + 1);
      node.id = n === 0 ? base : `${base}-${n}`;
      out.appendChild(node);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.appendChild(el('hr')); i += 1; continue; }

    // Table.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) { rows.push(splitRow(lines[i]!)); i += 1; }
      const thead = el('tr', {}, head.map((c) => { const th = el('th'); renderInline(c, th); return th; }));
      const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, head.map((_, idx) => { const td = el('td'); renderInline(r[idx] ?? '', td); return td; }))));
      const wrap = el('div', { class: 'legal-table-wrap' }, el('table', {}, [el('thead', {}, thead), tbody]));
      out.appendChild(wrap);
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) { buf.push(lines[i]!.replace(/^>\s?/, '')); i += 1; }
      const q = el('blockquote');
      q.appendChild(renderMarkdown(buf.join('\n')));
      out.appendChild(q);
      continue;
    }

    // Lists (one nesting level).
    const lm = LIST_RE.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[2]!);
      const baseIndent = lm[1]!.length;
      const list = el(ordered ? 'ol' : 'ul');
      let lastLi: HTMLElement | null = null;
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = LIST_RE.exec(cur);
        if (m && m[1]!.length <= baseIndent + 1) {
          const li = el('li');
          renderInline(m[3]!, li);
          list.appendChild(li);
          lastLi = li;
          i += 1;
        } else if (m && lastLi) {
          // Nested list: collect the deeper block and render it recursively.
          const buf: string[] = [];
          while (i < lines.length && LIST_RE.test(lines[i]!) && LIST_RE.exec(lines[i]!)![1]!.length > baseIndent + 1) {
            buf.push(lines[i]!.slice(Math.min(LIST_RE.exec(lines[i]!)![1]!.length, baseIndent + 2)));
            i += 1;
          }
          lastLi.appendChild(renderMarkdown(buf.join('\n')));
        } else if (/^\s+\S/.test(cur) && lastLi && !m) {
          // Continuation line of the previous item.
          lastLi.appendChild(document.createTextNode(` ${cur.trim()}`));
          i += 1;
        } else break;
      }
      out.appendChild(list);
      continue;
    }

    // Paragraph: consecutive non-blank lines that are not another block start.
    const buf: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]!) &&
      !/^(#{1,6}\s|```|>\s?|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i]!) &&
      !LIST_RE.test(lines[i]!) &&
      !(isTableRow(lines[i]!) && i + 1 < lines.length && isTableSep(lines[i + 1]!))
    ) {
      buf.push(lines[i]!.trim());
      i += 1;
    }
    const p = el('p');
    renderInline(buf.join(' '), p);
    out.appendChild(p);
  }
  return out;
}
