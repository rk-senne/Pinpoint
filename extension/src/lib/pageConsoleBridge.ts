/**
 * Host-page console / error bridge (fixes Mission C2 diagnostics in the
 * extension).
 *
 * Problem: Chrome runs content scripts in an ISOLATED world with its own
 * `console` object and only reports uncaught exceptions to listeners in the
 * world that threw. The content script's `ConsoleCapture` therefore saw
 * none of the host page's `console.error` calls or uncaught errors, so
 * every annotation was created with `consoleLogs: null, jsErrors: null`
 * (verified in real Chromium).
 *
 * Fix: the service worker injects {@link installPageConsoleBridge} into the
 * page's MAIN world via `chrome.scripting.executeScript({ world: 'MAIN' })`
 * (no extra manifest permission: the same host grant that allowed the
 * content script). The bridge wraps `console.warn` / `console.error`
 * (pass-through, original semantics preserved) and listens for `error` /
 * `unhandledrejection`, forwarding a plain, structured-clone-safe record via
 * a same-window `postMessage`. {@link listenForPageConsole} (isolated
 * world) validates the message and feeds it to `ConsoleCapture`, which owns
 * scrubbing, truncation and the ring-buffer bounds — so secrets are
 * scrubbed before anything is stored or sent.
 *
 * Trust: a host page can always post a forged record; that only lets a
 * site add noise to feedback about ITSELF, which is no worse than calling
 * `console.error` directly. Messages from other windows/frames or origins
 * are dropped.
 */
import type { ConsoleCapture, ConsoleLogLevel } from './consoleCapture';

/** Marker key carried by every bridged record. */
export const PAGE_CONSOLE_FLAG = '__pinpointPageConsole';

/** Runtime message the content script sends to ask for the MAIN-world bridge. */
export const INSTALL_PAGE_CONSOLE_MESSAGE_TYPE = 'PP_INSTALL_PAGE_CONSOLE' as const;

/** Wire shape posted from the MAIN world. */
export interface PageConsoleRecordConsole {
  [PAGE_CONSOLE_FLAG]: 1;
  kind: 'console';
  level: ConsoleLogLevel;
  args: unknown[];
}
export interface PageConsoleRecordError {
      [PAGE_CONSOLE_FLAG]: 1;
      kind: 'error' | 'unhandledrejection';
      message?: string;
      stack?: string;
      name?: string;
      filename?: string;
      lineno?: number;
      colno?: number;
      reason?: unknown;
}
export type PageConsoleRecord = PageConsoleRecordConsole | PageConsoleRecordError;

/**
 * Runs in the page's MAIN world. MUST be fully self-contained (it is
 * serialised by `chrome.scripting.executeScript({ func })`), so it may not
 * reference any module-scope binding — the marker key is passed in.
 * Idempotent per window.
 */
export function installPageConsoleBridge(flag: string): void {
  const w = window as unknown as Record<string, unknown>;
  const installedKey = `${flag}Installed`;
  if (w[installedKey]) return;
  w[installedKey] = true;

  const toPlain = (v: unknown): unknown => {
    if (v instanceof Error) {
      return { __error: 1, name: v.name, message: v.message, stack: v.stack };
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) {
      return v;
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const post = (record: Record<string, unknown>): void => {
    try {
      window.postMessage({ ...record, [flag]: 1 }, window.location.origin);
    } catch {
      /* opaque origins etc. — never break the page */
    }
  };

  (['warn', 'error'] as const).forEach((level) => {
    const original = console[level];
    console[level] = function pinpointPageConsole(...args: unknown[]): void {
      try {
        post({ kind: 'console', level, args: args.slice(0, 20).map(toPlain) });
      } catch {
        /* ignore */
      }
      return original.apply(console, args);
    };
  });

  window.addEventListener('error', (ev: ErrorEvent) => {
    const err = ev.error;
    post({
      kind: 'error',
      message: err instanceof Error ? err.message : String(ev.message ?? 'Error'),
      name: err instanceof Error ? err.name : undefined,
      stack: err instanceof Error ? err.stack : undefined,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
    });
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    post({ kind: 'unhandledrejection', reason: toPlain(ev.reason) });
  });
}

/** Rebuild an `Error` from its bridged plain form so stacks are kept. */
function revive(v: unknown): unknown {
  if (v && typeof v === 'object' && (v as { __error?: unknown }).__error === 1) {
    const o = v as { name?: string; message?: string; stack?: string };
    const e = new Error(String(o.message ?? ''));
    e.name = String(o.name ?? 'Error');
    if (typeof o.stack === 'string') e.stack = o.stack;
    return e;
  }
  return v;
}

/**
 * Isolated-world side: feed bridged records into `capture`. Returns a
 * teardown function.
 */
export function listenForPageConsole(
  capture: Pick<ConsoleCapture, 'recordConsole' | 'recordError'>,
  win: Window = window,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    // Same-window posts only. (`null` = synthetic/jsdom same-window event;
    // other frames always carry a non-null, different `source`.)
    if (event.source !== win && event.source !== null) return;
    if (event.origin && event.origin !== win.location.origin) return;
    const raw = event.data as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw[PAGE_CONSOLE_FLAG] !== 1) return;
    const data = raw as unknown as PageConsoleRecordConsole | PageConsoleRecordError;
    if (data.kind === 'console') {
      const rec = data as PageConsoleRecordConsole;
      if (rec.level !== 'warn' && rec.level !== 'error' && rec.level !== 'log') return;
      const args = Array.isArray(rec.args) ? rec.args.slice(0, 20).map(revive) : [];
      capture.recordConsole(rec.level, args);
      return;
    }
    if (data.kind === 'error') {
      const rec = data as PageConsoleRecordError;
      const error =
        typeof rec.stack === 'string'
          ? revive({ __error: 1, name: rec.name, message: rec.message, stack: rec.stack })
          : undefined;
      capture.recordError('error', {
        message: typeof rec.message === 'string' ? rec.message : 'Error',
        error,
        filename: typeof rec.filename === 'string' ? rec.filename : undefined,
        lineno: typeof rec.lineno === 'number' ? rec.lineno : undefined,
        colno: typeof rec.colno === 'number' ? rec.colno : undefined,
      });
      return;
    }
    if (data.kind === 'unhandledrejection') {
      const rec = data as PageConsoleRecordError;
      capture.recordError('unhandledrejection', { reason: revive(rec.reason) });
    }
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
