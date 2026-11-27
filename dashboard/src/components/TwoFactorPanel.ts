/**
 * TwoFactorPanel — TOTP two-factor authentication management (Settings → Profile).
 *
 * Talks to `/api/v1/auth/mfa*`. All DOM is built with `el()` / `setText()`
 * (no innerHTML). Secrets and recovery codes are held only in the DOM nodes of
 * the step that shows them and are discarded when that step is dismissed.
 *
 * Flow:
 *   disabled → [password] → enroll → shows the key (manual entry) → [6-digit code]
 *            → verify → shows 10 recovery codes ONCE → enabled
 *   enabled  → disable / regenerate recovery codes, each needing password + code
 */
import { el, setText } from '@pinpoint/shared';
import { apiFetch as defaultApiFetch } from '../lib/api';

interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export interface TwoFactorPanelOptions {
  apiFetch?: typeof defaultApiFetch;
}

const INPUT_STYLE =
  'display:block;width:100%;padding:6px 8px;margin-top:4px;border:1px solid var(--pp-border-medium);border-radius:4px;font-size:13px;box-sizing:border-box;';
const BTN_STYLE =
  'padding:8px 16px;background:var(--pp-accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:500;';
const BTN_SECONDARY_STYLE =
  'padding:8px 16px;background:none;color:var(--pp-text-secondary);border:1px solid var(--pp-border-medium);border-radius:4px;cursor:pointer;font-size:13px;';

let uid = 0;

function field(label: string, input: HTMLInputElement): HTMLElement {
  const id = `pp-2fa-${++uid}`;
  input.id = id;
  input.style.cssText = INPUT_STYLE;
  const l = el('label', { for: id });
  l.style.cssText = 'display:block;margin-bottom:12px;font-size:13px;';
  setText(l, label);
  l.append(input);
  return l;
}

function button(label: string, secondary = false, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const b = el('button', { type });
  b.style.cssText = secondary ? BTN_SECONDARY_STYLE : BTN_STYLE;
  setText(b, label);
  return b;
}

function note(message: string, tone: 'info' | 'error' = 'info'): HTMLElement {
  const p = el('p', { role: tone === 'error' ? 'alert' : 'status' });
  p.style.cssText = `font-size:13px;margin:0 0 12px;color:${tone === 'error' ? 'var(--pp-error-text)' : 'var(--pp-text-secondary)'};`;
  setText(p, message);
  return p;
}

/** Groups of four for readability when typing the key by hand. */
export function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export function mountTwoFactorPanel(container: HTMLElement, options: TwoFactorPanelOptions = {}): () => void {
  const api = options.apiFetch ?? defaultApiFetch;
  let disposed = false;

  const root = el('section', { 'data-role': 'two-factor-panel', 'aria-labelledby': 'pp-2fa-heading' });
  root.style.cssText = 'max-width:400px;margin-top:32px;padding-top:20px;border-top:1px solid var(--pp-border-heavy);';
  container.append(root);

  const body = el('div', { 'data-role': 'two-factor-body' });
  const heading = el('h2', { id: 'pp-2fa-heading' });
  heading.style.cssText = 'margin:0 0 8px;font-size:16px;';
  setText(heading, 'Two-factor authentication');
  root.append(heading, body);

  function show(...nodes: Node[]): void {
    if (disposed) return;
    body.replaceChildren(...nodes);
    // Keep keyboard / screen-reader users oriented after a step change.
    body.querySelector<HTMLElement>('input, button')?.focus?.();
  }

  const errorMessage = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

  async function load(): Promise<void> {
    show(note('Loading…'));
    try {
      const status = await api<MfaStatus>('/auth/mfa');
      if (status.enabled) renderEnabled(status);
      else renderDisabled();
    } catch (e) {
      show(note(errorMessage(e, 'Could not load two-factor settings.'), 'error'));
    }
  }

  // ---- disabled → enrollment -------------------------------------------
  function renderDisabled(): void {
    const intro = note(
      'Protect your account with a 6-digit code from an authenticator app (Google Authenticator, 1Password, Aegis, Authy…). You will also get single-use recovery codes.',
    );
    const start = button('Set up two-factor authentication');
    start.dataset.role = 'mfa-start';
    start.addEventListener('click', () => renderPasswordStep());
    show(intro, start);
  }

  function renderPasswordStep(): void {
    const form = el('form', { novalidate: true });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', name: 'password', required: true });
    const msg = note('', 'error');
    msg.hidden = true;
    const go = button('Continue', false, 'submit');
    const cancel = button('Cancel', true);
    cancel.addEventListener('click', () => renderDisabled());
    form.append(field('Confirm your current password', pw), msg, go, document.createTextNode(' '), cancel);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!pw.value) return;
      go.disabled = true;
      void (async () => {
        try {
          const r = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', {
            method: 'POST',
            body: JSON.stringify({ password: pw.value }),
          });
          pw.value = '';
          renderVerifyStep(r.secret);
        } catch (e) {
          setText(msg, errorMessage(e, 'Could not start enrollment.'));
          msg.hidden = false;
          go.disabled = false;
        }
      })();
    });
    show(form);
  }

  function renderVerifyStep(secret: string): void {
    const form = el('form', { novalidate: true });
    const steps = note('1. In your authenticator app choose “Enter a setup key” (time-based). 2. Enter this key. 3. Type the 6-digit code it shows.');
    const key = el('code', { 'data-role': 'mfa-secret' });
    key.style.cssText = 'display:block;margin:0 0 12px;padding:8px;background:var(--pp-bg-secondary, #f3f4f6);border-radius:4px;font-size:15px;letter-spacing:1px;user-select:all;word-break:break-all;';
    setText(key, formatSecret(secret));
    const code = el('input', {
      type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', required: true,
    });
    const msg = note('', 'error');
    msg.hidden = true;
    const go = button('Verify and enable', false, 'submit');
    const cancel = button('Cancel', true);
    cancel.addEventListener('click', () => void load());
    form.append(steps, key, field('6-digit code', code), msg, go, document.createTextNode(' '), cancel);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!/^\d{6}$/.test(code.value.trim())) {
        setText(msg, 'Enter the 6-digit code.');
        msg.hidden = false;
        return;
      }
      go.disabled = true;
      void (async () => {
        try {
          const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/verify', {
            method: 'POST',
            body: JSON.stringify({ code: code.value.trim() }),
          });
          renderRecoveryCodes(r.recoveryCodes);
        } catch (e) {
          setText(msg, errorMessage(e, 'That code is not valid.'));
          msg.hidden = false;
          go.disabled = false;
        }
      })();
    });
    show(form);
  }

  function renderRecoveryCodes(codes: string[]): void {
    const warn = note('Two-factor authentication is on. Save these recovery codes now — each works once if you lose your device. They will not be shown again.');
    const list = el('ul', { 'data-role': 'mfa-recovery-codes' });
    list.style.cssText = 'list-style:none;margin:0 0 12px;padding:8px;background:var(--pp-bg-secondary, #f3f4f6);border-radius:4px;font-family:monospace;font-size:14px;columns:2;';
    for (const c of codes) {
      const li = el('li');
      setText(li, c);
      list.append(li);
    }
    const copy = button('Copy codes', true);
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(codes.join('\n')).then(() => setText(copy, 'Copied'));
    });
    const done = button('I have saved them');
    done.addEventListener('click', () => {
      list.replaceChildren(); // drop the codes from the DOM
      void load();
    });
    show(warn, list, copy, document.createTextNode(' '), done);
  }

  // ---- enabled ----------------------------------------------------------
  function renderEnabled(status: MfaStatus): void {
    const state = note(
      `Two-factor authentication is ON. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.`,
    );
    const regen = button('Generate new recovery codes', true);
    regen.addEventListener('click', () => renderReauth('regenerate'));
    const off = button('Turn off two-factor authentication', true);
    off.dataset.role = 'mfa-disable';
    off.addEventListener('click', () => renderReauth('disable'));
    show(state, regen, document.createTextNode(' '), off);
  }

  function renderReauth(action: 'disable' | 'regenerate'): void {
    const form = el('form', { novalidate: true });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', name: 'password', required: true });
    const code = el('input', { type: 'text', name: 'code', autocomplete: 'one-time-code', maxlength: 32, required: true });
    const msg = note('', 'error');
    msg.hidden = true;
    const go = button(action === 'disable' ? 'Turn off' : 'Generate', false, 'submit');
    const cancel = button('Cancel', true);
    cancel.addEventListener('click', () => void load());
    form.append(
      note(action === 'disable' ? 'Confirm with your password and a current code (or a recovery code).' : 'Confirm with your password and a current code. Old recovery codes stop working.'),
      field('Current password', pw),
      field('Authenticator or recovery code', code),
      msg, go, document.createTextNode(' '), cancel,
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!pw.value || !code.value.trim()) return;
      go.disabled = true;
      void (async () => {
        try {
          const payload = JSON.stringify({ password: pw.value, code: code.value.trim() });
          if (action === 'disable') {
            await api<void>('/auth/mfa/disable', { method: 'POST', body: payload });
            await load();
          } else {
            const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { method: 'POST', body: payload });
            renderRecoveryCodes(r.recoveryCodes);
          }
        } catch (e) {
          setText(msg, errorMessage(e, 'Could not confirm. Check your password and code.'));
          msg.hidden = false;
          go.disabled = false;
        }
      })();
    });
    show(form);
  }

  void load();

  return () => {
    disposed = true;
    root.remove();
  };
}
