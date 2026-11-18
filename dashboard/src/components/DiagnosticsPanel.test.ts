// @vitest-environment jsdom
/**
 * DiagnosticsPanel.test.ts — Mission C2. Verifies the collapsible
 * "Console & errors" section renders console + error entries as inert text
 * (never innerHTML), hides when empty, and replaces (not stacks) on re-mount.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Annotation } from '@pinpoint/shared';
import {
  mountDiagnosticsPanel,
  DIAGNOSTICS_PANEL_ROLE,
} from './DiagnosticsPanel';

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = '';
});

function annotation(over: Partial<Annotation>): Pick<Annotation, 'consoleLogs' | 'jsErrors'> {
  return { consoleLogs: null, jsErrors: null, ...over };
}

describe('DiagnosticsPanel', () => {
  it('renders nothing when there is no diagnostics data', () => {
    mountDiagnosticsPanel(container, annotation({}));
    expect(container.querySelector(`[data-role="${DIAGNOSTICS_PANEL_ROLE}"]`)).toBeNull();
  });

  it('renders console + error rows with a combined count', () => {
    mountDiagnosticsPanel(
      container,
      annotation({
        consoleLogs: [
          { level: 'warn', message: 'careful', timestamp: '2026-11-13T12:00:00.000Z' },
          { level: 'error', message: 'broke', timestamp: '2026-11-13T12:00:01.000Z' },
        ],
        jsErrors: [
          {
            kind: 'unhandledrejection',
            message: 'rejected',
            timestamp: '2026-11-13T12:00:02.000Z',
          },
        ],
      }),
    );

    const panel = container.querySelector(`[data-role="${DIAGNOSTICS_PANEL_ROLE}"]`);
    expect(panel).not.toBeNull();
    expect(container.querySelector('[data-slot="diag-count"]')!.textContent).toBe('3');
    expect(container.querySelectorAll('[data-role="diag-console-row"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-role="diag-error-row"]')).toHaveLength(1);
    expect(container.textContent).toContain('REJECTION');
  });

  it('renders a hostile message as inert text (no innerHTML sink)', () => {
    const payload = '<img src=x onerror=alert(1)>';
    mountDiagnosticsPanel(
      container,
      annotation({
        consoleLogs: [
          { level: 'error', message: payload, timestamp: '2026-11-13T12:00:00.000Z' },
        ],
      }),
    );
    const msg = container.querySelector('[data-role="diag-message"]')!;
    expect(msg.querySelector('img')).toBeNull();
    expect(msg.textContent).toBe(payload);
  });

  it('replaces rather than stacks on re-mount', () => {
    const a = annotation({
      jsErrors: [{ kind: 'error', message: 'one', timestamp: '2026-11-13T12:00:00.000Z' }],
    });
    mountDiagnosticsPanel(container, a);
    mountDiagnosticsPanel(container, a);
    expect(
      container.querySelectorAll(`[data-role="${DIAGNOSTICS_PANEL_ROLE}"]`),
    ).toHaveLength(1);
  });

  it('shows source:line:col for window error entries', () => {
    mountDiagnosticsPanel(
      container,
      annotation({
        jsErrors: [
          {
            kind: 'error',
            message: 'boom',
            timestamp: '2026-11-13T12:00:00.000Z',
            source: 'https://app/x.js',
            lineno: 42,
            colno: 7,
          },
        ],
      }),
    );
    expect(container.querySelector('[data-role="diag-loc"]')!.textContent).toBe(
      'https://app/x.js:42:7',
    );
  });
});
