/**
 * DiagnosticsPanel — Mission C2.
 *
 * Renders a collapsible "Console & errors" section in the annotation detail
 * view from the additive `annotation.consoleLogs` + `annotation.jsErrors`
 * fields captured by the widget / extension `consoleCapture` module.
 *
 * All dynamic data is written through `setText` / `el` from
 * `@pinpoint/shared` (never `innerHTML`), so a hostile log line such as
 * `<img src=x onerror=alert(1)>` or a scrubbed-but-still-attacker-controlled
 * message renders as inert text. The client-side scrubbing happened at
 * capture time; this component is the second line of defence on render.
 *
 * The section is hidden entirely when there is nothing to show so
 * non-diagnostic annotations never display an empty panel. The caller
 * (ProjectView) mounts this once per selection via `mountDiagnosticsPanel`.
 */

import type { Annotation, ConsoleLogEntry, JsErrorEntry } from '@pinpoint/shared';
import { el, setText } from '@pinpoint/shared';

/** Stable `data-role` so tests and ProjectView can find the mounted section. */
export const DIAGNOSTICS_PANEL_ROLE = 'diagnostics-panel';

function levelLabel(level: ConsoleLogEntry['level']): string {
  switch (level) {
    case 'error':
      return 'ERROR';
    case 'warn':
      return 'WARN';
    default:
      return 'LOG';
  }
}

/** Short HH:MM:SS from an ISO timestamp; falls back to the raw value. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

function buildConsoleRow(entry: ConsoleLogEntry): HTMLLIElement {
  const li = el('li', { class: 'fl-diag-row', 'data-role': 'diag-console-row' });
  const level = el('span', {
    class: `fl-diag-level fl-diag-level-${entry.level}`,
    'data-role': 'diag-level',
  });
  setText(level, levelLabel(entry.level));
  const time = el('span', { class: 'fl-diag-time' });
  setText(time, shortTime(entry.timestamp));
  const msg = el('span', { class: 'fl-diag-msg', 'data-role': 'diag-message' });
  setText(msg, entry.message);
  li.append(level, time, msg);
  if (entry.stack) {
    const stack = el('pre', { class: 'fl-diag-stack', 'data-role': 'diag-stack' });
    setText(stack, entry.stack);
    li.appendChild(stack);
  }
  return li as HTMLLIElement;
}

function buildErrorRow(entry: JsErrorEntry): HTMLLIElement {
  const li = el('li', { class: 'fl-diag-row', 'data-role': 'diag-error-row' });
  const kind = el('span', {
    class: 'fl-diag-level fl-diag-level-error',
    'data-role': 'diag-kind',
  });
  setText(kind, entry.kind === 'unhandledrejection' ? 'REJECTION' : 'ERROR');
  const time = el('span', { class: 'fl-diag-time' });
  setText(time, shortTime(entry.timestamp));
  const msg = el('span', { class: 'fl-diag-msg', 'data-role': 'diag-message' });
  setText(msg, entry.message);
  li.append(kind, time, msg);

  if (entry.source) {
    const loc = el('span', { class: 'fl-diag-loc', 'data-role': 'diag-loc' });
    const where =
      entry.lineno != null
        ? `${entry.source}:${entry.lineno}${entry.colno != null ? `:${entry.colno}` : ''}`
        : entry.source;
    setText(loc, where);
    li.appendChild(loc);
  }
  if (entry.stack) {
    const stack = el('pre', { class: 'fl-diag-stack', 'data-role': 'diag-stack' });
    setText(stack, entry.stack);
    li.appendChild(stack);
  }
  return li as HTMLLIElement;
}

/**
 * Mount (or re-mount) the diagnostics section into `container`. Any existing
 * `[data-role="diagnostics-panel"]` subtree is removed first so repeated
 * calls across annotation selections do not stack panels.
 *
 * Returns a teardown that removes the mounted section.
 */
export function mountDiagnosticsPanel(
  container: HTMLElement,
  annotation: Pick<Annotation, 'consoleLogs' | 'jsErrors'>,
): () => void {
  // Clean up a previous render so selection changes replace rather than stack.
  container
    .querySelectorAll(`[data-role="${DIAGNOSTICS_PANEL_ROLE}"]`)
    .forEach((n) => n.remove());

  const consoleLogs = (annotation.consoleLogs ?? []) as ConsoleLogEntry[];
  const jsErrors = (annotation.jsErrors ?? []) as JsErrorEntry[];

  if (consoleLogs.length === 0 && jsErrors.length === 0) {
    // Nothing to show — render nothing (no empty panel).
    return () => {};
  }

  const total = consoleLogs.length + jsErrors.length;

  const summary = el('summary', { class: 'fl-diag-summary' });
  const title = el('span', { class: 'fl-diag-title' });
  setText(title, 'Console & errors');
  const count = el('span', { class: 'fl-diag-count', 'data-slot': 'diag-count' });
  setText(count, String(total));
  summary.append(title, count);

  const body = el('div', { class: 'fl-diag-body' });

  if (jsErrors.length > 0) {
    const h = el('h5', { class: 'fl-diag-subhead' });
    setText(h, `Uncaught errors (${jsErrors.length})`);
    const ul = el('ul', { class: 'fl-diag-list', 'data-role': 'diag-errors' });
    ul.append(...jsErrors.map(buildErrorRow));
    body.append(h, ul);
  }

  if (consoleLogs.length > 0) {
    const h = el('h5', { class: 'fl-diag-subhead' });
    setText(h, `Console (${consoleLogs.length})`);
    const ul = el('ul', { class: 'fl-diag-list', 'data-role': 'diag-console' });
    ul.append(...consoleLogs.map(buildConsoleRow));
    body.append(h, ul);
  }

  // `<details>` gives a zero-JS collapsible; collapsed by default so the
  // detail view stays compact. `el` does not allow-list `open`, so toggle it
  // directly on the created element (it starts closed, which is desired).
  const details = el('details', {
    class: 'fl-diagnostics-panel',
    'data-role': DIAGNOSTICS_PANEL_ROLE,
  });
  details.append(summary, body);
  container.appendChild(details);

  return () => {
    details.remove();
  };
}

export default mountDiagnosticsPanel;
