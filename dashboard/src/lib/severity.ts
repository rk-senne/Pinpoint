/**
 * Accessible severity text colour for the Dashboard.
 *
 * `SEVERITY_COLORS` from `@pinpoint/shared` are brand swatches (pins, chart
 * dots, borders). Used as TEXT on white they fail WCAG AA (critical #ef4444
 * 3.8:1, minor #eab308 1.9:1). Text therefore uses the per-theme
 * `--pp-severity-<level>-text` tokens from `styles/theme.css`, which are tuned
 * for both light and dark mode.
 */
const TOKEN: Record<string, string> = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  informational: 'info',
  info: 'info',
};

/** CSS colour value (a `var(...)`) for severity text; neutral text for unknown levels. */
export function severityTextColor(severity: string | null | undefined): string {
  const token = severity ? TOKEN[severity] : undefined;
  return token ? `var(--pp-severity-${token}-text)` : 'var(--pp-text-primary)';
}
