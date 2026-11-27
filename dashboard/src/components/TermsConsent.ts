/**
 * TermsConsent — the REQUIRED "I agree to the Terms and Privacy Policy"
 * checkbox on the registration form (GDPR Art. 7(1) / POPIA s.11: an
 * unticked-by-default, affirmative act that we can later prove; the server
 * stores `accepted_terms_at` + `terms_version`).
 *
 * Built with `el()` (no innerHTML). The row is inserted into the form just
 * before the submit button and is only visible in register mode.
 */

import { el } from '@pinpoint/shared';

export interface TermsConsentHandle {
  readonly row: HTMLElement;
  readonly input: HTMLInputElement;
  /** Show/hide the row (register mode only). Hiding also unchecks it. */
  setVisible(visible: boolean): void;
  isChecked(): boolean;
  /** Mark the checkbox invalid (and announce why) / clear the error. */
  setError(message: string | null): void;
}

function legalLink(href: string, label: string): HTMLAnchorElement {
  const a = el('a', { href }, label);
  a.setAttribute('data-route', '');
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener');
  a.style.color = 'var(--pp-link-alt)';
  return a;
}

export function mountTermsConsent(before: Element): TermsConsentHandle {
  const input = el('input', {
    id: 'fl-auth-terms',
    name: 'acceptTerms',
    type: 'checkbox',
    required: true,
    'aria-describedby': 'fl-auth-terms-error',
  });
  input.style.marginTop = '3px';
  const error = el('div', { id: 'fl-auth-terms-error', role: 'alert', hidden: true });
  error.style.cssText = 'color: var(--pp-error-text); font-size: 12px; margin-top: 4px;';
  const label = el('label', { for: 'fl-auth-terms' }, [
    'I agree to the ',
    legalLink('/legal/terms', 'Terms of Service'),
    ' and ',
    legalLink('/legal/privacy', 'Privacy Policy'),
    '.',
  ]);
  const line = el('div', { 'data-role': 'terms-line' }, [input, label]);
  line.style.cssText = 'display: flex; gap: 8px; align-items: flex-start; font-size: 13px;';
  const row = el('div', { 'data-slot': 'termsConsent', hidden: true }, [line, error]);
  row.style.marginBottom = '16px';
  before.parentElement?.insertBefore(row, before);

  return {
    row,
    input,
    setVisible(visible) {
      row.hidden = !visible;
      if (!visible) {
        input.checked = false;
        this.setError(null);
      }
    },
    isChecked: () => input.checked,
    setError(message) {
      error.textContent = message ?? '';
      error.hidden = message === null;
      if (message === null) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
    },
  };
}
