/**
 * consoleCapture — Mission C2 (widget copy).
 *
 * The `<script>` widget is a self-contained Vite bundle with no dependency on
 * `@pinpoint/shared` or the extension workspace (see widget/tsconfig.json
 * `rootDir: src`), so it carries its own copy of the bounded, PII-aware
 * console + JS-error capture used by the extension
 * (`extension/src/lib/consoleCapture.ts`). The behavior is identical:
 *
 *   - Captures `window` `error` + `unhandledrejection` and `console.error` /
 *     `console.warn` (optionally `console.log`).
 *   - Ring buffers bounded to {@link MAX_ENTRIES} (50) each, FIFO eviction.
 *   - Messages truncated to {@link MESSAGE_MAX} (500), stacks to
 *     {@link STACK_MAX} (2000).
 *   - `snapshot()` clamps the serialized `{consoleLogs, jsErrors}` payload to
 *     {@link MAX_SERIALIZED_BYTES} (32 KB) by dropping oldest entries.
 *   - Scrubs Bearer tokens, sensitive query params, JWT-looking strings, and
 *     (optionally) emails before storage.
 *   - Pass-through console semantics; `uninstall()` restores everything.
 */

export type ConsoleLogLevel = 'log' | 'warn' | 'error';
export type JsErrorKind = 'error' | 'unhandledrejection';

export interface ConsoleLogEntry {
  level: ConsoleLogLevel;
  message: string;
  timestamp: string;
  stack?: string;
}

export interface JsErrorEntry {
  kind: JsErrorKind;
  message: string;
  timestamp: string;
  stack?: string;
  source?: string;
  lineno?: number;
  colno?: number;
}

export interface ConsoleCaptureSnapshot {
  consoleLogs: ConsoleLogEntry[];
  jsErrors: JsErrorEntry[];
}

export interface ConsoleCaptureOptions {
  readonly captureLog?: boolean;
  readonly scrubEmails?: boolean;
  readonly maxEntries?: number;
  readonly console?: Pick<Console, 'log' | 'warn' | 'error'>;
  readonly window?: WindowLike;
  readonly now?: () => Date;
}

export interface WindowLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

export const MAX_ENTRIES = 50;
export const MESSAGE_MAX = 500;
export const STACK_MAX = 2000;
export const MAX_SERIALIZED_BYTES = 32 * 1024;

const CONSOLE_LEVELS: readonly ConsoleLogLevel[] = ['log', 'warn', 'error'];
const REDACTED = '[REDACTED]';

/** Luhn checksum over a digit string. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** True when `b64` decodes to `user:pass` (a real HTTP Basic credential). */
function isBasicCredential(b64: string): boolean {
  try {
    return typeof atob === 'function' && atob(b64).includes(':');
  } catch {
    return false;
  }
}

const SENSITIVE_KEY =
  '[\\w-]*(?:token|password|passwd|pwd|api[_-]?key|secret|auth|session|sig(?:nature)?|credential)[\\w-]*';

/**
 * Extra secret shapes beyond `key=value` / Bearer / JWT / email:
 *   - JSON / object-literal style `"password":"x"`, `'token': 'x'`, `secret: x`
 *   - `Basic <base64(user:pass)>` (validated by decoding, so "Basic setup" is kept)
 *   - Pinpoint / Stripe style keys `pk_…` `sk_…` `rk_…`, plus GitHub / AWS ids
 *   - payment card numbers: 13–19 digits (spaces/dashes allowed) passing Luhn
 */
function scrubStructuredSecrets(input: string): string {
  let out = input.replace(
    new RegExp(
      `(["']?)(${SENSITIVE_KEY})\\1(\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|(?:(?:Basic|Bearer)\\s+)?[^\\s,}\\]]+)`,
      'gi',
    ),
    (_m, q: string, key: string, sep: string, val: string) => {
      const vq = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
      return `${q}${key}${q}${sep}${vq}${REDACTED}${vq}`;
    },
  );
  out = out.replace(/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/g, (m, b64: string) =>
    isBasicCredential(b64) ? `Basic ${REDACTED}` : m,
  );
  out = out.replace(/\b(?:pk|sk|rk)_[A-Za-z0-9_]{8,}\b/g, REDACTED);
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED);
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);
  out = out.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? REDACTED : m;
  });
  return out;
}

export function scrubSecrets(input: string, scrubEmails = true): string {
  let out = input;
  try {
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
    out = out.replace(
      /\b([\w-]*(?:token|password|passwd|pwd|api[_-]?key|secret|auth|session|sig(?:nature)?)[\w-]*)=([^&\s"'`]+)/gi,
      (_m, key: string) => `${key}=${REDACTED}`,
    );
    out = scrubStructuredSecrets(out);
    out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED);
    if (scrubEmails) {
      out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED);
    }
  } catch {
    return input;
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function firstErrorStack(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error && typeof arg.stack === 'string') return arg.stack;
  }
  return undefined;
}

type WrappableMethod = (...args: unknown[]) => void;

export class ConsoleCapture {
  private readonly captureLog: boolean;
  private readonly scrubEmails: boolean;
  private readonly maxEntries: number;
  private readonly console: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly win: WindowLike | null;
  private readonly now: () => Date;

  private readonly consoleBuf: ConsoleLogEntry[] = [];
  private readonly errorBuf: JsErrorEntry[] = [];

  private originals: Partial<Record<ConsoleLogLevel, WrappableMethod>> = {};
  private onError: ((ev: unknown) => void) | null = null;
  private onRejection: ((ev: unknown) => void) | null = null;
  private installed = false;

  constructor(options: ConsoleCaptureOptions = {}) {
    this.captureLog = options.captureLog ?? false;
    this.scrubEmails = options.scrubEmails ?? true;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (this.maxEntries < 1) throw new Error('ConsoleCapture: maxEntries must be >= 1');
    this.console =
      options.console ?? (globalThis.console as Pick<Console, 'log' | 'warn' | 'error'>);
    this.win =
      options.window ??
      (typeof window !== 'undefined' ? (window as unknown as WindowLike) : null);
    this.now = options.now ?? (() => new Date());
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    const levels: ConsoleLogLevel[] = this.captureLog
      ? ['log', 'warn', 'error']
      : ['warn', 'error'];
    for (const level of levels) this.wrap(level);

    if (this.win) {
      this.onError = (ev: unknown): void => {
        try {
          this.pushError(this.fromErrorEvent(ev));
        } catch {
          /* capture must never break the host page */
        }
      };
      this.onRejection = (ev: unknown): void => {
        try {
          this.pushError(this.fromRejectionEvent(ev));
        } catch {
          /* capture must never break the host page */
        }
      };
      this.win.addEventListener('error', this.onError);
      this.win.addEventListener('unhandledrejection', this.onRejection);
    }
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;

    for (const level of CONSOLE_LEVELS) {
      const original = this.originals[level];
      if (original) this.console[level] = original as Console[typeof level];
    }
    this.originals = {};

    if (this.win) {
      if (this.onError) this.win.removeEventListener('error', this.onError);
      if (this.onRejection) {
        this.win.removeEventListener('unhandledrejection', this.onRejection);
      }
    }
    this.onError = null;
    this.onRejection = null;
  }

  getConsoleLogs(): ConsoleLogEntry[] {
    return this.consoleBuf.map((e) => ({ ...e }));
  }

  getJsErrors(): JsErrorEntry[] {
    return this.errorBuf.map((e) => ({ ...e }));
  }

  clear(): void {
    this.consoleBuf.length = 0;
    this.errorBuf.length = 0;
  }

  snapshot(): ConsoleCaptureSnapshot {
    let consoleLogs = this.getConsoleLogs();
    let jsErrors = this.getJsErrors();

    const size = (): number => byteLength(JSON.stringify({ consoleLogs, jsErrors }));

    while (
      size() > MAX_SERIALIZED_BYTES &&
      (consoleLogs.length > 0 || jsErrors.length > 0)
    ) {
      if (consoleLogs.length >= jsErrors.length && consoleLogs.length > 0) {
        consoleLogs = consoleLogs.slice(1);
      } else if (jsErrors.length > 0) {
        jsErrors = jsErrors.slice(1);
      } else {
        consoleLogs = consoleLogs.slice(1);
      }
    }
    return { consoleLogs, jsErrors };
  }

  private wrap(level: ConsoleLogLevel): void {
    const original = this.console[level].bind(this.console) as WrappableMethod;
    this.originals[level] = this.console[level] as WrappableMethod;

    const self = this;
    (this.console[level] as WrappableMethod) = function consoleCaptureWrapped(
      ...args: unknown[]
    ): void {
      try {
        self.pushConsole(level, args);
      } catch {
        /* never break the host page's console */
      }
      original(...args);
    };
  }

  private pushConsole(level: ConsoleLogLevel, args: unknown[]): void {
    const entry: ConsoleLogEntry = {
      level,
      message: truncate(scrubSecrets(formatArgs(args), this.scrubEmails), MESSAGE_MAX),
      timestamp: this.now().toISOString(),
    };
    if (level !== 'log') {
      const stack = firstErrorStack(args);
      if (stack) entry.stack = truncate(scrubSecrets(stack, this.scrubEmails), STACK_MAX);
    }
    this.consoleBuf.push(entry);
    if (this.consoleBuf.length > this.maxEntries) this.consoleBuf.shift();
  }

  private pushError(entry: JsErrorEntry): void {
    this.errorBuf.push(entry);
    if (this.errorBuf.length > this.maxEntries) this.errorBuf.shift();
  }

  private fromErrorEvent(ev: unknown): JsErrorEntry {
    const e = ev as Partial<ErrorEvent> & { error?: unknown };
    const err = e.error;
    let message: string;
    let stack: string | undefined;
    if (err instanceof Error) {
      message = `${err.name}: ${err.message}`;
      stack = typeof err.stack === 'string' ? err.stack : undefined;
    } else {
      message = typeof e.message === 'string' ? e.message : String(e.message ?? 'Error');
    }
    const entry: JsErrorEntry = {
      kind: 'error',
      message: truncate(scrubSecrets(message, this.scrubEmails), MESSAGE_MAX),
      timestamp: this.now().toISOString(),
    };
    if (stack) entry.stack = truncate(scrubSecrets(stack, this.scrubEmails), STACK_MAX);
    if (typeof e.filename === 'string' && e.filename) {
      entry.source = truncate(scrubSecrets(e.filename, this.scrubEmails), 2048);
    }
    if (typeof e.lineno === 'number') entry.lineno = e.lineno;
    if (typeof e.colno === 'number') entry.colno = e.colno;
    return entry;
  }

  private fromRejectionEvent(ev: unknown): JsErrorEntry {
    const e = ev as { reason?: unknown };
    const reason = e.reason;
    let message: string;
    let stack: string | undefined;
    if (reason instanceof Error) {
      message = `${reason.name}: ${reason.message}`;
      stack = typeof reason.stack === 'string' ? reason.stack : undefined;
    } else if (typeof reason === 'string') {
      message = reason;
    } else {
      try {
        message = JSON.stringify(reason);
      } catch {
        message = String(reason);
      }
    }
    const entry: JsErrorEntry = {
      kind: 'unhandledrejection',
      message: truncate(scrubSecrets(message, this.scrubEmails), MESSAGE_MAX),
      timestamp: this.now().toISOString(),
    };
    if (stack) entry.stack = truncate(scrubSecrets(stack, this.scrubEmails), STACK_MAX);
    return entry;
  }
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return Buffer.byteLength(value, 'utf8');
}

export default ConsoleCapture;
