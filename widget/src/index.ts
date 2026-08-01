import { getStyles, defaultTheme, type WidgetTheme } from './styles.js';

export type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface PinpointConfig {
  projectKey: string;
  position?: Position;
  theme?: Partial<WidgetTheme>;
  apiUrl?: string;
}

interface FeedbackPayload {
  description: string;
  severity: 'critical' | 'major' | 'minor' | 'informational';
  email?: string;
  pageUrl: string;
  viewport: { width: number; height: number };
  userAgent: string;
}

const FEEDBACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2zm0 15.2L18.8 16H4V4h16v13.2zM7 9h2v2H7V9zm4 0h2v2h-2V9zm4 0h2v2h-2V9z"/></svg>`;

class PinpointWidget {
  private config!: Required<Pick<PinpointConfig, 'projectKey' | 'position'>> & {
    theme: WidgetTheme;
    apiUrl: string;
  };
  private shadow: ShadowRoot | null = null;
  private host: HTMLElement | null = null;
  private isOpen = false;

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

    this.renderTrigger();
    document.body.appendChild(this.host);
  }

  private renderTrigger(): void {
    if (!this.shadow) return;

    const trigger = document.createElement('button');
    trigger.className = `pinpoint-trigger position-${this.config.position}`;
    trigger.innerHTML = FEEDBACK_ICON;
    trigger.setAttribute('aria-label', 'Send feedback');
    trigger.setAttribute('type', 'button');
    trigger.addEventListener('click', () => this.open());
    this.shadow.appendChild(trigger);
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
    modal.setAttribute('aria-label', 'Send feedback');
    modal.innerHTML = this.getFormHTML();

    overlay.appendChild(modal);
    this.shadow.appendChild(overlay);

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
    const overlay = this.shadow.querySelector('.pinpoint-overlay');
    overlay?.remove();
    this.isOpen = false;
  }

  private getFormHTML(): string {
    return `
      <h2>Send Feedback</h2>
      <form id="pinpoint-form">
        <div class="pinpoint-form-group">
          <label for="pinpoint-description">Description</label>
          <textarea
            id="pinpoint-description"
            placeholder="Describe the issue or feedback..."
            required
            maxlength="2000"
          ></textarea>
        </div>
        <div class="pinpoint-form-group">
          <label for="pinpoint-severity">Severity</label>
          <select id="pinpoint-severity">
            <option value="informational">Informational</option>
            <option value="minor">Minor</option>
            <option value="major">Major</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div class="pinpoint-form-group">
          <label for="pinpoint-email">Email <span class="optional">(optional)</span></label>
          <input
            id="pinpoint-email"
            type="email"
            placeholder="your@email.com"
          />
        </div>
        <div class="pinpoint-actions">
          <button type="button" id="pinpoint-cancel" class="pinpoint-btn pinpoint-btn-secondary">
            Cancel
          </button>
          <button type="submit" id="pinpoint-submit" class="pinpoint-btn pinpoint-btn-primary">
            Submit
          </button>
        </div>
      </form>
    `;
  }

  private async handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.shadow) return;

    const submitBtn = this.shadow.querySelector<HTMLButtonElement>('#pinpoint-submit');
    const description = this.shadow.querySelector<HTMLTextAreaElement>('#pinpoint-description')?.value.trim();
    const severity = this.shadow.querySelector<HTMLSelectElement>('#pinpoint-severity')?.value as FeedbackPayload['severity'];
    const email = this.shadow.querySelector<HTMLInputElement>('#pinpoint-email')?.value.trim();

    if (!description) return;

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    const payload: FeedbackPayload = {
      description,
      severity,
      pageUrl: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      userAgent: navigator.userAgent,
    };

    if (email) {
      payload.email = email;
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
      });

      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error?.message ?? `Request failed (${response.status})`);
      }

      this.showMessage('success', 'Thank you!', 'Your feedback has been submitted.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      this.showMessage('error', 'Submission failed', message);
    }
  }

  private resolveApiUrl(): string {
    // Attempt to derive the API URL from the script's src attribute
    const scripts = document.querySelectorAll('script[src]');
    for (const script of scripts) {
      const src = script.getAttribute('src') ?? '';
      if (src.includes('pinpoint-widget') || src.includes('widget.js')) {
        try {
          const url = new URL(src);
          return url.origin;
        } catch {
          // relative URL, use current origin
        }
      }
    }
    return window.location.origin;
  }

  private showMessage(type: 'success' | 'error', title: string, subtitle: string): void {
    if (!this.shadow) return;

    const modal = this.shadow.querySelector('.pinpoint-modal');
    if (!modal) return;

    modal.innerHTML = `
      <div class="pinpoint-message ${type}">
        <p>${title}</p>
        <small>${subtitle}</small>
      </div>
      <div class="pinpoint-actions">
        <button type="button" id="pinpoint-close" class="pinpoint-btn pinpoint-btn-secondary" style="flex:1">
          Close
        </button>
      </div>
    `;

    const closeBtn = this.shadow.querySelector<HTMLButtonElement>('#pinpoint-close');
    closeBtn?.addEventListener('click', () => this.close());

    // Auto-close after 3 seconds on success
    if (type === 'success') {
      setTimeout(() => this.close(), 3000);
    }
  }

  destroy(): void {
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
