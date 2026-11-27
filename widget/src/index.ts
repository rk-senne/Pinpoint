import { getStyles, defaultTheme, type WidgetTheme } from './styles.js';
import {
  ConsoleCapture,
  type ConsoleLogEntry,
  type JsErrorEntry,
} from './consoleCapture.js';
import { sanitizePageUrl } from './pageUrl.js';

export type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface PinpointConfig {
  projectKey: string;
  position?: Position;
  theme?: Partial<WidgetTheme>;
  apiUrl?: string;
  /**
   * Capture a bounded, PII-scrubbed snapshot of console output + uncaught JS
   * errors and attach it to each submission (Mission C2). Defaults to `true`.
   * Set `false` to disable the capture entirely.
   */
  captureDiagnostics?: boolean;
}

interface FeedbackPayload {
  description: string;
  severity: 'critical' | 'major' | 'minor' | 'informational';
  email?: string;
  pageUrl: string;
  viewport: { width: number; height: number };
  userAgent: string;
  /** Bounded, scrubbed console snapshot (Mission C2). */
  consoleLogs?: ConsoleLogEntry[];
  /** Bounded, scrubbed uncaught-error snapshot (Mission C2). */
  jsErrors?: JsErrorEntry[];
}

const FEEDBACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.2L18.8 16H4V4h16v13.2zM7 9h2v2H7V9zm4 0h2v2h-2V9zm4 0h2v2h-2V9z"/></svg>`;

/** Exact path the API serves the bundle from (widgetAsset.routes.ts). */
export const WIDGET_SCRIPT_PATH = '/widget/pinpoint-widget.js';

/**
 * `document.currentScript` is only set while the script first executes, so
 * capture its absolute `src` at load time (null for module/async-injected
 * loads or non-script contexts).
 */
const LOAD_TIME_SCRIPT_SRC: string | null = (() => {
  try {
    const cs = typeof document !== 'undefined' ? document.currentScript : null;
    return cs instanceof HTMLScriptElement && cs.src ? cs.src : null;
  } catch {
    return null;
  }
})();

/**
 * Derive the API origin: (1) the load-time script's own origin — that script
 * IS this widget, so its origin is trustworthy; (2) otherwise a script tag
 * whose pathname is EXACTLY {@link WIDGET_SCRIPT_PATH} (a loose
 * `includes('widget.js')` match would let any unrelated script, e.g. a
 * third-party `evil-widget.js`, redirect feedback to its origin);
 * (3) the page origin. An explicit `apiUrl` config bypasses all of this.
 */
export function resolveApiOrigin(
  loadTimeSrc: string | null,
  doc: Pick<Document, 'querySelectorAll'>,
  fallbackOrigin: string,
): string {
  if (loadTimeSrc) {
    try {
      return new URL(loadTimeSrc, fallbackOrigin).origin;
    } catch {
      /* fall through */
    }
  }
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    try {
      const url = new URL(script.getAttribute('src') ?? '', fallbackOrigin);
      if (url.pathname === WIDGET_SCRIPT_PATH) return url.origin;
    } catch {
      /* ignore malformed src */
    }
  }
  return fallbackOrigin;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Circle + check mark; `aria-hidden`, colour via `currentColor`. */
function createSuccessIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pinpoint-success-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '48');
  svg.setAttribute('height', '48');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  const check = document.createElementNS(SVG_NS, 'path');
  check.setAttribute('d', 'm8 12.5 2.8 2.8L16.5 9.5');
  svg.append(circle, check);
  return svg;
}

class PinpointWidget {
  private config!: Required<Pick<PinpointConfig, 'projectKey' | 'position'>> & {
    theme: WidgetTheme;
    apiUrl: string;
    captureDiagnostics: boolean;
  };
  private shadow: ShadowRoot | null = null;
  private host: HTMLElement | null = null;
  private isOpen = false;
  private trigger: HTMLButtonElement | null = null;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Diagnostics capture (Mission C2); null when disabled. */
  private capture: ConsoleCapture | null = null;

  constructor(config: PinpointConfig) {
    if (!config.projectKey) {
      console.error('[Pinpoint] projectKey is required');
      return;
    }

    this.config = {
      projectKey: config.projectKey,
      position: config.position ?? 'bottom-right',
      theme: { ...defaultTheme, ...config.theme },
      apiUrl: config.apiUrl ?? '',
      captureDiagnostics: config.captureDiagnostics ?? true,
    };

    this.mount();
  }

  private mount(): void {
    this.host = document.createElement('div');
    this.host.id = 'pinpoint-widget-host';
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = getStyles(this.config.theme);
    this.shadow.appendChild(style);

    // Mission C2 — begin bounded, PII-scrubbed console + JS-error capture as
    // early as possible so a submission carries the context that led up to
    // it. Capture never alters the host page's console semantics
    // (pass-through) and is torn down in `destroy()`.
    if (this.config.captureDiagnostics && this.capture === null) {
      try {
        this.capture = new ConsoleCapture();
        this.capture.install();
      } catch {
        this.capture = null;
      }
    }

    this.renderTrigger();
    document.body.appendChild(this.host);
  }

  private renderTrigger(): void {
    if (!this.shadow) return;

    const trigger = document.createElement('button');
    trigger.className = `pinpoint-trigger position-${this.config.position}`;
    // eslint-disable-next-line no-restricted-syntax -- FEEDBACK_ICON is a static SVG constant
    trigger.innerHTML = FEEDBACK_ICON;
    trigger.setAttribute('aria-label', 'Send feedback');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('title', 'Send feedback');
    trigger.setAttribute('type', 'button');
    trigger.addEventListener('click', () => this.open());
    this.shadow.appendChild(trigger);
    this.trigger = trigger;
  }

  private open(): void {
    if (this.isOpen || !this.shadow) return;
    this.isOpen = true;

    const overlay = document.createElement('div');
    overlay.className = 'pinpoint-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'pinpoint-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'pinpoint-title');
    modal.replaceChildren(this.buildForm());
    // Escape closes; Tab stays inside the dialog (it is modal).
    modal.addEventListener('keydown', (e) => this.onModalKeydown(e, modal));

    overlay.appendChild(modal);
    this.shadow.appendChild(overlay);
    this.trigger?.setAttribute('aria-expanded', 'true');

    // Focus first input
    const textarea = this.shadow.querySelector<HTMLTextAreaElement>('#pinpoint-description');
    textarea?.focus();

    // Bind form events
    const form = this.shadow.querySelector<HTMLFormElement>('#pinpoint-form');
    form?.addEventListener('submit', (e) => this.handleSubmit(e));

    const cancelBtn = this.shadow.querySelector<HTMLButtonElement>('#pinpoint-cancel');
    cancelBtn?.addEventListener('click', () => this.close());
  }

  private close(): void {
    if (!this.shadow) return;
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    const overlay = this.shadow.querySelector('.pinpoint-overlay');
    if (!overlay) return;
    overlay.remove();
    this.isOpen = false;
    this.trigger?.setAttribute('aria-expanded', 'false');
    // Return focus to the control that opened the dialog.
    this.trigger?.focus();
  }

  private onModalKeydown(e: KeyboardEvent, modal: HTMLElement): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Tab' || !this.shadow) return;
    const focusables = Array.from(
      modal.querySelectorAll<HTMLElement>('button, textarea, input, select, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.shadow.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Show (or clear, with `null`) an inline validation message for a field. */
  private setFieldError(field: HTMLTextAreaElement | HTMLInputElement, message: string | null): void {
    const id = `${field.id}-error`;
    let el = this.shadow?.getElementById(id) ?? null;
    if (message === null) {
      el?.remove();
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      return;
    }
    if (!el) {
      el = document.createElement('p');
      el.id = id;
      el.className = 'pinpoint-field-error';
      field.insertAdjacentElement('afterend', el);
    }
    el.textContent = message;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', id);
  }

  /**
   * Build the feedback form imperatively. All content is created through
   * `document.createElement` + `textContent`/`setAttribute` — never
   * `innerHTML` — so nothing here can introduce a markup-injection sink even
   * if the host page's styling or future dynamic labels change.
   */
  private buildForm(): DocumentFragment {
    const frag = document.createDocumentFragment();

    const heading = document.createElement('h2');
    heading.id = 'pinpoint-title';
    heading.textContent = 'Send feedback';
    frag.appendChild(heading);

    const form = document.createElement('form');
    form.id = 'pinpoint-form';
    // Inline, accessible messages instead of the browser's native bubbles
    // (which were inconsistent and silently ignored whitespace-only text).
    form.noValidate = true;

    // Description
    const descGroup = document.createElement('div');
    descGroup.className = 'pinpoint-form-group';
    const descLabel = document.createElement('label');
    descLabel.setAttribute('for', 'pinpoint-description');
    descLabel.textContent = 'Description';
    const textarea = document.createElement('textarea');
    textarea.id = 'pinpoint-description';
    textarea.setAttribute('placeholder', 'Describe the issue or feedback...');
    textarea.required = true;
    textarea.maxLength = 2000;
    descGroup.append(descLabel, textarea);

    // Severity
    const sevGroup = document.createElement('div');
    sevGroup.className = 'pinpoint-form-group';
    const sevLabel = document.createElement('label');
    sevLabel.setAttribute('for', 'pinpoint-severity');
    sevLabel.textContent = 'Severity';
    const select = document.createElement('select');
    select.id = 'pinpoint-severity';
    const severities: Array<[FeedbackPayload['severity'], string]> = [
      ['informational', 'Informational'],
      ['minor', 'Minor'],
      ['major', 'Major'],
      ['critical', 'Critical'],
    ];
    for (const [value, label] of severities) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    sevGroup.append(sevLabel, select);

    // Email
    const emailGroup = document.createElement('div');
    emailGroup.className = 'pinpoint-form-group';
    const emailLabel = document.createElement('label');
    emailLabel.setAttribute('for', 'pinpoint-email');
    emailLabel.append('Email ');
    const optional = document.createElement('span');
    optional.className = 'optional';
    optional.textContent = '(optional)';
    emailLabel.appendChild(optional);
    const emailInput = document.createElement('input');
    emailInput.id = 'pinpoint-email';
    emailInput.type = 'email';
    emailInput.setAttribute('placeholder', 'your@email.com');
    emailGroup.append(emailLabel, emailInput);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'pinpoint-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.id = 'pinpoint-cancel';
    cancel.className = 'pinpoint-btn pinpoint-btn-secondary';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.id = 'pinpoint-submit';
    submit.className = 'pinpoint-btn pinpoint-btn-primary';
    submit.textContent = 'Submit';
    actions.append(cancel, submit);

    form.append(descGroup, sevGroup, emailGroup, actions);
    frag.appendChild(form);
    return frag;
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.shadow) return;

    const submitBtn = this.shadow.querySelector<HTMLButtonElement>('#pinpoint-submit');
    const description = this.shadow.querySelector<HTMLTextAreaElement>('#pinpoint-description')?.value.trim();
    const severity = this.shadow.querySelector<HTMLSelectElement>('#pinpoint-severity')?.value as FeedbackPayload['severity'];
    const email = this.shadow.querySelector<HTMLInputElement>('#pinpoint-email')?.value.trim();

    const textarea = this.shadow.querySelector<HTMLTextAreaElement>('#pinpoint-description');
    const emailInput = this.shadow.querySelector<HTMLInputElement>('#pinpoint-email');
    let invalid: HTMLElement | null = null;
    if (textarea) {
      this.setFieldError(textarea, description ? null : 'Please describe the issue or idea.');
      if (!description) invalid = textarea;
    }
    if (emailInput) {
      const badEmail = !!email && (emailInput.validity?.typeMismatch || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
      this.setFieldError(emailInput, badEmail ? 'Enter a valid email address, or leave it empty.' : null);
      if (badEmail && !invalid) invalid = emailInput;
    }
    if (invalid || !description) {
      invalid?.focus();
      return;
    }
    this.shadow.querySelector('.pinpoint-message.error')?.remove();

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    const payload: FeedbackPayload = {
      description,
      severity,
      pageUrl: sanitizePageUrl(window.location.href),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      userAgent: navigator.userAgent,
    };

    if (email) {
      payload.email = email;
    }

    // Mission C2 — attach a bounded, scrubbed snapshot clamped to ≤32 KB.
    // Only include the arrays when non-empty so the common no-error case
    // keeps the payload minimal.
    if (this.capture) {
      try {
        const snap = this.capture.snapshot();
        if (snap.consoleLogs.length > 0) payload.consoleLogs = snap.consoleLogs;
        if (snap.jsErrors.length > 0) payload.jsErrors = snap.jsErrors;
      } catch {
        // Capture failures must never block a submission.
      }
    }

    try {
      const baseUrl = this.config.apiUrl || this.resolveApiUrl();
      const response = await fetch(`${baseUrl}/api/v1/widget/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Key': this.config.projectKey,
        },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Network failure or a CORS rejection (e.g. this site's origin is
        // not on the key's allow-list): the browser only exposes an opaque
        // "Failed to fetch", which means nothing to a site visitor.
        throw new Error("We couldn't reach the feedback service. Please try again later.");
      });

      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error?.message ?? `Request failed (${response.status})`);
      }

      this.showMessage('success', 'Thank you!', 'Your feedback has been submitted.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      this.showError(message);
    }
  }

  /**
   * Submission failed: keep the form (and everything the user typed) and
   * show the reason inline so they can retry. Previously the form was
   * replaced by the error, throwing the user's text away.
   */
  private showError(subtitle: string): void {
    if (!this.shadow) return;
    const form = this.shadow.querySelector<HTMLFormElement>('#pinpoint-form');
    if (!form) {
      this.showMessage('error', 'Submission failed', subtitle);
      return;
    }
    this.shadow.querySelector('.pinpoint-message.error')?.remove();
    const message = document.createElement('div');
    message.className = 'pinpoint-message error';
    message.setAttribute('role', 'alert');
    const titleEl = document.createElement('p');
    titleEl.textContent = 'Submission failed';
    // Server-supplied text: textContent only (never markup).
    const subtitleEl = document.createElement('small');
    subtitleEl.textContent = subtitle;
    message.append(titleEl, subtitleEl);
    const actions = form.querySelector('.pinpoint-actions');
    form.insertBefore(message, actions);
    const submitBtn = this.shadow.querySelector<HTMLButtonElement>('#pinpoint-submit');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Try again';
    }
  }

  private resolveApiUrl(): string {
    return resolveApiOrigin(LOAD_TIME_SCRIPT_SRC, document, window.location.origin);
  }

  private showMessage(type: 'success' | 'error', title: string, subtitle: string): void {
    if (!this.shadow) return;

    const modal = this.shadow.querySelector('.pinpoint-modal');
    if (!modal) return;

    // `subtitle` can carry a server-supplied error message. Build via DOM so
    // a payload like `<img src=x onerror=alert(1)>` renders as inert text.
    const message = document.createElement('div');
    message.className = `pinpoint-message ${type}`;
    message.setAttribute('role', type === 'error' ? 'alert' : 'status');
    // Decorative success mark (inline SVG, hidden from assistive tech: the
    // heading + status role already say it). Built via the SVG namespace —
    // never innerHTML.
    if (type === 'success') message.appendChild(createSuccessIcon());
    const titleEl = document.createElement('h2');
    // The form (with its heading) is replaced; keep the dialog's
    // `aria-labelledby` pointing at a real, non-empty element.
    titleEl.id = 'pinpoint-title';
    titleEl.className = 'pinpoint-message-title';
    titleEl.textContent = title;
    const subtitleEl = document.createElement('small');
    subtitleEl.textContent = subtitle;
    message.append(titleEl, subtitleEl);

    const actions = document.createElement('div');
    actions.className = 'pinpoint-actions';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'pinpoint-close';
    closeBtn.className = 'pinpoint-btn pinpoint-btn-secondary';
    closeBtn.style.flex = '1';
    closeBtn.textContent = 'Close';
    actions.appendChild(closeBtn);

    modal.replaceChildren(message, actions);

    closeBtn.addEventListener('click', () => this.close());
    // The form (and its focused control) was just replaced — keep keyboard
    // focus inside the dialog.
    closeBtn.focus();

    // Auto-close after 3 seconds on success
    if (type === 'success') {
      this.autoCloseTimer = setTimeout(() => this.close(), 3000);
    }
  }

  destroy(): void {
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = null;
    if (this.capture) {
      try {
        this.capture.uninstall();
      } catch {
        // ignore teardown failures
      }
      this.capture = null;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
  }
}

// Expose global API
interface PinpointGlobal {
  init(config: PinpointConfig): void;
  destroy(): void;
}

let instance: PinpointWidget | null = null;

const PinpointAPI: PinpointGlobal = {
  init(config: PinpointConfig): void {
    if (instance) {
      instance.destroy();
    }
    instance = new PinpointWidget(config);
  },
  destroy(): void {
    instance?.destroy();
    instance = null;
  },
};

// Attach to window
(window as unknown as { Pinpoint: PinpointGlobal }).Pinpoint = PinpointAPI;

export default PinpointAPI;
