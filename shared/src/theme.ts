// @pinpoint/shared — shared palette & labels (single source of truth)
//
// Implements design.md decision #11 / Requirement 26.1: a single map from
// Severity to hex color and from annotation status to human-readable label,
// consumed unchanged by both Dashboard and Extension.

import type { Severity, AnnotationStatus } from './types.js';

/**
 * Severity_Colors: maps each Severity value to its hex color string.
 * Stable across light and dark modes (Req 43.2).
 */
export const SEVERITY_COLORS = {
  critical: '#ef4444',
  major: '#f97316',
  minor: '#eab308',
  informational: '#3b82f6',
} as const satisfies Record<Severity, string>;

/**
 * Status_Labels: maps each annotation status value to its human-readable label.
 */
export const STATUS_LABELS = {
  active: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
} as const satisfies Record<AnnotationStatus, string>;

/**
 * Light-mode neutrals (default `:root` palette). Used by Dashboard pages and
 * Extension Shadow Roots when `prefers-color-scheme` is `light` (or no
 * preference is reported). Severity values are intentionally NOT listed here
 * — they live in {@link SEVERITY_COLORS} and stay constant across modes
 * (Req 43.2).
 */
const LIGHT_NEUTRALS = {
  '--fl-bg': '#ffffff',
  '--fl-surface': '#f8fafc',
  '--fl-text': '#0f172a',
  '--fl-border': '#e2e8f0',
  '--fl-muted': '#64748b',
  '--fl-accent': '#3b82f6',
} as const;

/**
 * Dark-mode neutrals. Applied via `@media (prefers-color-scheme: dark)` —
 * only the four neutrals named in design decision #29 plus the surface flip;
 * Severity_Colors are deliberately untouched per Req 43.2.
 */
const DARK_NEUTRALS = {
  '--fl-bg': '#0f172a',
  '--fl-surface': '#1e293b',
  '--fl-text': '#f1f5f9',
  '--fl-border': '#334155',
  '--fl-muted': '#94a3b8',
} as const;

/**
 * Emits a CSS Custom Properties block exposing the shared palette and labels
 * under `:root` (and `:host` so it also applies inside Shadow Roots that
 * adopt this stylesheet). Variables follow `--fl-severity-<severity>` and
 * `--fl-status-<status>` naming. Status label values are emitted as quoted
 * strings so they can be consumed via `content: var(--fl-status-active);`.
 *
 * The output also carries a `@media (prefers-color-scheme: dark)` block that
 * overrides ONLY the neutral variables (`--fl-bg`, `--fl-surface`,
 * `--fl-text`, `--fl-border`, `--fl-muted`). Severity values stay constant
 * across modes because severity carries a semantic meaning (Critical is red)
 * that should not flip in the dark (Req 43.1, 43.2).
 */
export function themeCss(): string {
  const neutralLines = Object.entries(LIGHT_NEUTRALS)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  const severityLines = (Object.keys(SEVERITY_COLORS) as Severity[])
    .map((key) => `  --fl-severity-${key}: ${SEVERITY_COLORS[key]};`)
    .join('\n');

  const statusLines = (Object.keys(STATUS_LABELS) as AnnotationStatus[])
    .map((key) => `  --fl-status-${key.replace(/_/g, '-')}: "${STATUS_LABELS[key]}";`)
    .join('\n');

  const darkOverrideLines = Object.entries(DARK_NEUTRALS)
    .map(([name, value]) => `    ${name}: ${value};`)
    .join('\n');

  return (
    `:host, :root {\n${neutralLines}\n${severityLines}\n${statusLines}\n}\n` +
    `@media (prefers-color-scheme: dark) {\n` +
    `  :host, :root {\n${darkOverrideLines}\n  }\n` +
    `}\n`
  );
}

/**
 * A constructable `CSSStyleSheet` containing `themeCss()`, ready to be
 * attached to a Shadow Root via `adoptedStyleSheets`.
 *
 * `CSSStyleSheet` (and `replaceSync`) is not available in every environment
 * — notably Node test runners (jsdom/happy-dom may or may not provide it).
 * In environments where it is unavailable, this export is `undefined` and
 * consumers should fall back to a `<style>` tag containing `themeCss()`.
 */
export const sharedStyleSheet: CSSStyleSheet | undefined = (() => {
  try {
    if (typeof CSSStyleSheet === 'undefined') return undefined;
    const sheet = new CSSStyleSheet();
    if (typeof sheet.replaceSync !== 'function') return undefined;
    sheet.replaceSync(themeCss());
    return sheet;
  } catch {
    return undefined;
  }
})();
