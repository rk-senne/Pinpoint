/**
 * consoleCapture — Mission C2.
 *
 * Bounded, PII-aware capture of a host page's console output and uncaught
 * JavaScript errors, attached to a create-annotation payload as the additive
 * `consoleLogs` + `jsErrors` fields. This is deliberately SEPARATE from the
 * extension's `CaptureBuffer` (Req 36): `CaptureBuffer` records console +
 * network for the extension's bug-report popover; `consoleCapture` is a
 * smaller, scrubbing-first module shared by BOTH the `<script>` widget and
 * the extension content script.
 *
 * Guarantees:
 *   - Captures `window` `error` + `unhandledrejection` events and
 *     `console.error` / `console.warn` (and optionally `console.log`).
 *   - Ring buffers bounded to `MAX_ENTRIES` (50) each; FIFO eviction.
 *   - Every message truncated to `MESSAGE_MAX` (500) chars, every stack to
 *     `STACK_MAX` (2000) chars.
 *   - The serialized `{ consoleLogs, jsErrors }` payload is clamped to
 *     `MAX_SERIALIZED_BYTES` (32 KB): `snapshot()` drops oldest entries until
 *     it fits.
 *   - Obvious secrets scrubbed before storage: Bearer tokens, `token=` /
 *     `password=` / `api_key=` (and common variants) query params, JWT-looking
 *     strings, and (optionally) email addresses.
 *   - Host `console` semantics are preserved: wrappers call the original
 *     implementation unchanged (pass-through) and never swallow throws.
 *   - `uninstall()` restores the originals and removes the event listeners.
 *
 * The module keeps zero dependency on `chrome.*` so the identical build runs
 * inside the widget bundle and the extension content script.
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
  /** Capture `console.log` in addition to warn/error. Defaults to `false`. */
  readonly captureLog?: boolean;
  /** Also scrub email-looking substrings. Defaults to `true`. */
  readonly scrubEmails?: boolean;
  /** Per-buffer entry cap. Defaults to {@link MAX_ENTRIES}. */
  readonly maxEntries?: number;
  /** Console to wrap. Defaults to the global `console`. */
  readonly console?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Window to attach error listeners to. Defaults to the global `window`. */
  readonly window?: WindowLike;
  /** Timestamp source. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Minimal window surface needed for error capture (testable without jsdom). */
export interface WindowLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

export const MAX_ENTRIES = 50;
export const MESSAGE_MAX = 500;
export const STACK_MAX = 2000;
export const MAX_SERIALIZED_BYTES = 32 * 1024;

const CONSOLE_LEVELS: readonly ConsoleLogLevel[] = ['log', 'warn', 'error'];

// --- Scrubbing -------------------------------------------------------------

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

/**
 * Scrub obvious secrets from an arbitrary string. Ordered so broad patterns
 * (query params) run before the standalone JWT/bearer matchers, and all are
 * idempotent. Never throws — a bad regex input returns the original string.
 */
export function scrubSecrets(input: string, scrubEmails = true): string {
  let out = input;
  try {
    // `Authorization: Bearer <token>` and bare `Bearer <token>`.
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);

    // Sensitive query-string / form params: token, access_token, id_token,
    // refresh_token, password, pwd, passwd, api_key, apikey, secret,
    // client_secret, auth, session, sig, signature. Match `key=value` up to
    // the next `&`, whitespace, quote, or end.
    out = out.replace(
      /\b([\w-]*(?:token|password|passwd|pwd|api[_-]?key|secret|auth|session|sig(?:nature)?)[\w-]*)=([^&\s"'`]+)/gi,
      (_m, key: string) => `${key}=${REDACTED}`,
    );

    out = scrubStructuredSecrets(out);
    // JWT-looking strings: three base64url segments separated by dots.
    out = out.replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      REDACTED,
    );

    if (scrubEmails) {
      out = out.replace(
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        REDACTED,
      );
    }
  } catch {
    return input;
  }
  return out;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/** Format `console.*` arguments into a single string (Errors → stack). */
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

// --- Capture ---------------------------------------------------------------

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

  /** Begin capture. Idempotent. */
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

  /** Stop capture and restore originals. Idempotent. */
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

  /**
   * Record a console call observed OUTSIDE this JS world (e.g. forwarded
   * from the host page's MAIN world by `pageConsoleBridge`). Goes through
   * the same scrubbing / truncation / ring-buffer bounds as wrapped calls.
   */
  recordConsole(level: ConsoleLogLevel, args: unknown[]): void {
    if (!CONSOLE_LEVELS.includes(level)) return;
    if (level === 'log' && !this.captureLog) return;
    try {
      this.pushConsole(level, Array.isArray(args) ? args : [String(args)]);
    } catch {
      /* capture must never break the caller */
    }
  }

  /**
   * Record an uncaught error / unhandled rejection observed outside this JS
   * world. Accepts the plain fields of an `ErrorEvent`
   * (`message`/`filename`/`lineno`/`colno`, optional `error`) or of a
   * `PromiseRejectionEvent` (`reason`).
   */
  recordError(kind: JsErrorKind, ev: unknown): void {
    try {
      this.pushError(kind === 'unhandledrejection' ? this.fromRejectionEvent(ev) : this.fromErrorEvent(ev));
    } catch {
      /* capture must never break the caller */
    }
  }

  /** Oldest-first snapshot of the captured console entries. */
  getConsoleLogs(): ConsoleLogEntry[] {
    return this.consoleBuf.map((e) => ({ ...e }));
  }

  /** Oldest-first snapshot of the captured error entries. */
  getJsErrors(): JsErrorEntry[] {
    return this.errorBuf.map((e) => ({ ...e }));
  }

  /** Drop every captured entry. */
  clear(): void {
    this.consoleBuf.length = 0;
    this.errorBuf.length = 0;
  }

  /**
   * Snapshot both buffers clamped to {@link MAX_SERIALIZED_BYTES}. Drops the
   * OLDEST entries (both streams in lock-step) until the serialized payload
   * fits. Returns a fresh, caller-owned object safe to attach to a payload.
   */
  snapshot(): ConsoleCaptureSnapshot {
    let consoleLogs = this.getConsoleLogs();
    let jsErrors = this.getJsErrors();

    const size = (): number =>
      byteLength(JSON.stringify({ consoleLogs, jsErrors }));

    // Trim from the front (oldest) until it fits or both are empty.
    while (size() > MAX_SERIALIZED_BYTES && (consoleLogs.length > 0 || jsErrors.length > 0)) {
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

  // --- internals -----------------------------------------------------------

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
      // Pass-through: call the original with the original args unchanged.
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

/** UTF-8 byte length that works in both the browser and Node (tests). */
function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  // Node fallback.
  return Buffer.byteLength(value, 'utf8');
}

export default ConsoleCapture;
