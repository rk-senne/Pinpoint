// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleCapture } from './consoleCapture';
import { PAGE_CONSOLE_FLAG, installPageConsoleBridge, listenForPageConsole } from './pageConsoleBridge';

/** jsdom delivers postMessage asynchronously. */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('pageConsoleBridge', () => {
  let capture: ConsoleCapture;
  let stop: () => void;
  const realError = console.error;
  const realWarn = console.warn;

  beforeEach(() => {
    // A capture that does NOT wrap the global console — it models the
    // isolated world, which never sees the page's console calls directly.
    capture = new ConsoleCapture({
      console: { log() {}, warn() {}, error() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    });
    capture.install();
    stop = listenForPageConsole(capture);
  });

  afterEach(() => {
    stop();
    capture.uninstall();
    console.error = realError;
    console.warn = realWarn;
    delete (window as unknown as Record<string, unknown>)[`${PAGE_CONSOLE_FLAG}Installed`];
  });

  // Runs first: window listeners from installs cannot be removed in jsdom.
  it('forwards uncaught errors and unhandled rejections as jsErrors', async () => {
    installPageConsoleBridge(PAGE_CONSOLE_FLAG);
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Uncaught Error: boom', error: new Error('boom'), filename: 'app.js', lineno: 3, colno: 7 }),
    );
    const rej = new Event('unhandledrejection') as Event & { reason?: unknown };
    rej.reason = 'nope';
    window.dispatchEvent(rej);
    await flush();
    const errs = capture.snapshot().jsErrors;
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({ kind: 'error', message: 'Error: boom', source: 'app.js', lineno: 3, colno: 7 });
    expect(errs[1]).toMatchObject({ kind: 'unhandledrejection', message: 'nope' });
  });

  it('forwards page console.error / console.warn into the capture (scrubbed), passing through', async () => {
    const spy = vi.fn();
    console.error = spy;
    installPageConsoleBridge(PAGE_CONSOLE_FLAG);
    console.error('Pricing API failed', 'token=abc123secret');
    console.warn('slow', { ms: 900 });
    expect(spy).toHaveBeenCalledWith('Pricing API failed', 'token=abc123secret');
    await flush();
    const logs = capture.snapshot().consoleLogs;
    expect(logs.map((l) => l.level)).toEqual(['error', 'warn']);
    expect(logs[0].message).toContain('Pricing API failed');
    expect(logs[0].message).not.toContain('abc123secret');
    expect(logs[1].message).toContain('{"ms":900}');
  });

  it('keeps an Error argument stack', async () => {
    console.error = () => {};
    installPageConsoleBridge(PAGE_CONSOLE_FLAG);
    const err = new TypeError('bad thing');
    console.error(err);
    await flush();
    const [entry] = capture.snapshot().consoleLogs;
    expect(entry.message).toContain('bad thing');
    expect(entry.stack).toBeTruthy();
  });

  it('is idempotent per window (no double wrapping)', async () => {
    console.error = () => {};
    installPageConsoleBridge(PAGE_CONSOLE_FLAG);
    installPageConsoleBridge(PAGE_CONSOLE_FLAG);
    console.error('once');
    await flush();
    expect(capture.snapshot().consoleLogs).toHaveLength(1);
  });

  it('ignores messages without the marker or from another source', async () => {
    window.postMessage({ kind: 'console', level: 'error', args: ['x'] }, '*');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { [PAGE_CONSOLE_FLAG]: 1, kind: 'console', level: 'error', args: ['spoof'] },
        // A different window (e.g. a child iframe) must be rejected.
        source: document.createElement('iframe') as unknown as MessageEventSource,
      }),
    );
    await flush();
    expect(capture.snapshot().consoleLogs).toHaveLength(0);
  });
});
