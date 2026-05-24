import { describe, it, expect } from 'vitest';
import { themeCss, SEVERITY_COLORS, STATUS_LABELS } from './theme.js';

describe('themeCss', () => {
  describe('base :root block', () => {
    it('emits one --fl-severity-<key> line per SEVERITY_COLORS entry with the canonical hex value', () => {
      const css = themeCss();
      for (const [key, value] of Object.entries(SEVERITY_COLORS)) {
        expect(css).toContain(`--fl-severity-${key}: ${value};`);
      }
    });

    it('emits one --fl-status-<key> line per STATUS_LABELS entry, with underscores converted to hyphens and the label quoted', () => {
      const css = themeCss();
      for (const [key, label] of Object.entries(STATUS_LABELS)) {
        const cssKey = key.replace(/_/g, '-');
        expect(css).toContain(`--fl-status-${cssKey}: "${label}";`);
      }
    });

    it('declares the light-mode neutrals on :host, :root', () => {
      const css = themeCss();
      // The base block selector pairs `:host` (for adopted stylesheets in
      // Shadow Roots) with `:root` (for the document) so the same sheet
      // works in both contexts. See design.md decision #11.
      expect(css).toMatch(/:host,\s*:root\s*{/);
      expect(css).toMatch(/--fl-bg:\s*#ffffff;/);
      expect(css).toMatch(/--fl-surface:\s*#f8fafc;/);
      expect(css).toMatch(/--fl-text:\s*#0f172a;/);
      expect(css).toMatch(/--fl-border:\s*#e2e8f0;/);
      expect(css).toMatch(/--fl-muted:\s*#64748b;/);
    });
  });

  describe('dark mode (Req 43.1)', () => {
    it('contains a @media (prefers-color-scheme: dark) block', () => {
      const css = themeCss();
      expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*{/);
    });

    it('overrides every neutral variable inside the dark block', () => {
      const dark = extractDarkBlock(themeCss());
      expect(dark).toMatch(/--fl-bg:\s*#0f172a;/);
      expect(dark).toMatch(/--fl-surface:\s*#1e293b;/);
      expect(dark).toMatch(/--fl-text:\s*#f1f5f9;/);
      expect(dark).toMatch(/--fl-border:\s*#334155;/);
      expect(dark).toMatch(/--fl-muted:\s*#94a3b8;/);
    });

    it('targets :host, :root inside the dark block so the override works in both Document and Shadow Root contexts', () => {
      const dark = extractDarkBlock(themeCss());
      expect(dark).toMatch(/:host,\s*:root\s*{/);
    });
  });

  describe('Severity_Colors are stable across modes (Req 43.2)', () => {
    it('does NOT redeclare any --fl-severity-* variable inside the dark block', () => {
      const dark = extractDarkBlock(themeCss());
      // The dark block must not contain ANY --fl-severity-* override —
      // severity carries semantic meaning (Critical is red, etc.) that
      // must not flip with the OS color scheme.
      expect(dark).not.toMatch(/--fl-severity-/);
    });

    it.each(Object.keys(SEVERITY_COLORS))(
      'does not override --fl-severity-%s in dark mode',
      (severity) => {
        const dark = extractDarkBlock(themeCss());
        expect(dark).not.toContain(`--fl-severity-${severity}`);
      }
    );

    it('does NOT redeclare any --fl-status-* variable inside the dark block', () => {
      const dark = extractDarkBlock(themeCss());
      expect(dark).not.toMatch(/--fl-status-/);
    });

    it('every --fl-severity-* declaration in the whole sheet still resolves to the canonical SEVERITY_COLORS value', () => {
      const css = themeCss();
      for (const [key, value] of Object.entries(SEVERITY_COLORS)) {
        // Match every line declaring this variable; assert each carries the
        // same canonical value. If a regression introduced a dark-mode
        // override with a different hex, this catches it.
        const re = new RegExp(`--fl-severity-${key}:\\s*([^;]+);`, 'g');
        const matches = [...css.matchAll(re)];
        expect(matches.length).toBeGreaterThan(0);
        for (const m of matches) {
          expect(m[1].trim()).toBe(value);
        }
      }
    });

    it('parses both blocks and asserts each light --fl-severity-* is absent from or identical in dark', () => {
      // Parse the light :root block and the dark :root block independently,
      // collecting their --fl-severity-<name>: <value> declarations into
      // maps. Then assert: for every severity defined in light, the dark
      // block must either OMIT it (inheriting the light value) OR redeclare
      // it with the *identical* value. This is the literal Req 43.2
      // contract — Severity_Colors are stable across modes.
      const css = themeCss();
      const light = extractLightBlock(css);
      const dark = extractDarkBlock(css);

      const severityRe = /--fl-severity-([a-z]+):\s*([^;]+);/g;

      const lightSeverities = new Map<string, string>();
      for (const m of light.matchAll(severityRe)) {
        lightSeverities.set(m[1], m[2].trim());
      }
      const darkSeverities = new Map<string, string>();
      for (const m of dark.matchAll(severityRe)) {
        darkSeverities.set(m[1], m[2].trim());
      }

      // Light must declare every Severity_Colors key.
      expect(lightSeverities.size).toBe(Object.keys(SEVERITY_COLORS).length);
      for (const [key, value] of Object.entries(SEVERITY_COLORS)) {
        expect(lightSeverities.get(key)).toBe(value);
      }

      // Dark must NOT introduce any severity key that isn't already in light.
      for (const key of darkSeverities.keys()) {
        expect(lightSeverities.has(key)).toBe(true);
      }

      // For every severity defined in light, dark either omits it (preferred,
      // inherited via the cascade) or redeclares it with the identical value.
      for (const [key, lightValue] of lightSeverities) {
        if (darkSeverities.has(key)) {
          expect(darkSeverities.get(key)).toBe(lightValue);
        } else {
          expect(darkSeverities.has(key)).toBe(false);
        }
      }
    });
  });
});

/**
 * Extracts the body of the light-mode `:root { ... }` block — i.e. the
 * top-level `:host, :root { ... }` rule that appears BEFORE the `@media`
 * dark-mode block. Uses brace counting to handle the rule body cleanly.
 */
function extractLightBlock(css: string): string {
  const mediaIdx = css.indexOf('@media');
  const head = mediaIdx >= 0 ? css.slice(0, mediaIdx) : css;
  const openBrace = head.indexOf('{');
  expect(openBrace).toBeGreaterThanOrEqual(0);
  let depth = 1;
  let i = openBrace + 1;
  while (i < head.length && depth > 0) {
    const c = head[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  expect(depth).toBe(0);
  return head.slice(openBrace + 1, i);
}

/**
 * Extracts the body of the `@media (prefers-color-scheme: dark) { ... }`
 * block from `themeCss()` output. Uses brace counting so it correctly
 * handles the nested `:host, :root { ... }` selector inside.
 */
function extractDarkBlock(css: string): string {
  const idx = css.indexOf('@media');
  expect(idx).toBeGreaterThanOrEqual(0);
  // Find the opening brace of the @media rule.
  const openBrace = css.indexOf('{', idx);
  expect(openBrace).toBeGreaterThanOrEqual(0);
  let depth = 1;
  let i = openBrace + 1;
  while (i < css.length && depth > 0) {
    const c = css[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  expect(depth).toBe(0);
  return css.slice(openBrace + 1, i);
}
