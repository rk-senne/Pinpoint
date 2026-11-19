/**
 * Renders docs/CRASH_COURSE.md into
 *   - docs/CRASH_COURSE.html            (self-contained: inline CSS, base64 images)
 *   - docs/crash-course/CRASH_COURSE.pdf (A4, via Playwright's Chromium)
 *
 *   npm run docs:crash-course            both
 *   npm run docs:crash-course -- --no-pdf  HTML only
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = resolve(ROOT, 'docs');
const SRC = resolve(DOCS, 'CRASH_COURSE.md');
const HTML_OUT = resolve(DOCS, 'CRASH_COURSE.html');
const PDF_OUT = resolve(DOCS, 'crash-course', 'CRASH_COURSE.pdf');

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

const missing: string[] = [];
const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`;
    },
    image({ href, title, text }) {
      let src = href;
      if (!/^(https?:|data:)/.test(href)) {
        const file = resolve(DOCS, href);
        if (existsSync(file)) {
          src = `data:${MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(file).toString('base64')}`;
        } else {
          missing.push(href);
        }
      }
      const cap = text ? `<figcaption>${esc(text)}</figcaption>` : '';
      return `<figure><img src="${src}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>${cap}</figure>`;
    },
  },
});

const CSS = `
:root { --ink:#1a1d29; --muted:#5b6275; --brand:#4f46e5; --line:#e3e6ee; --code:#f4f5f9; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; background: #fff; }
main { max-width: 820px; margin: 0 auto; padding: 48px 32px 80px; }
h1 { font-size: 2.2rem; line-height: 1.2; margin: 0 0 .4em; color: var(--brand); }
h2 { font-size: 1.55rem; margin: 2.2em 0 .6em; padding-bottom: .25em; border-bottom: 2px solid var(--brand); }
h3 { font-size: 1.15rem; margin: 1.6em 0 .4em; }
p, li { orphans: 3; widows: 3; }
a { color: var(--brand); text-decoration: none; }
code { background: var(--code); padding: .1em .35em; border-radius: 4px; font: .88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--line); }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: .4em 1em; border-left: 4px solid var(--brand); background: #f7f7ff; color: var(--muted); }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .92em; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f4f5f9; }
tr, figure, img { break-inside: avoid; }
figure { margin: 1.2em 0; text-align: center; }
img { max-width: 100%; max-height: 520px; height: auto; border: 1px solid var(--line); border-radius: 8px; }
figcaption { font-size: .82em; color: var(--muted); margin-top: 6px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
@page { size: A4; margin: 18mm 16mm; }
@media print {
  main { max-width: none; padding: 0; }
  body { font-size: 11pt; }
  h2 { break-before: page; break-after: avoid; margin-top: 0; }
  main > h1 + * ~ h2:first-of-type { break-before: auto; }
  h3, h4 { break-after: avoid; }
  img { max-height: 105mm; max-width: 100%; }
  pre { white-space: pre-wrap; break-inside: avoid; }
  a { color: inherit; }
}
`;

async function main(): Promise<void> {
  const md = readFileSync(SRC, 'utf8');
  const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? 'Pinpoint Crash Course';
  const body = await marked.parse(md);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  writeFileSync(HTML_OUT, html);
  console.log(`HTML  ${HTML_OUT} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  if (missing.length) console.warn(`WARNING: ${missing.length} missing image(s): ${missing.join(', ')}`);

  if (process.argv.includes('--no-pdf')) return;
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    mkdirSync(dirname(PDF_OUT), { recursive: true });
    await page.pdf({
      path: PDF_OUT,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#888;padding:0 16mm;display:flex;justify-content:space-between"><span>${esc(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    console.log(`PDF   ${PDF_OUT}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`build-crash-course: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
