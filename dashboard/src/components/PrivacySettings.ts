/**
 * PrivacySettings — the Settings → Privacy tab: data-subject-rights tools.
 *
 *   Export my data            GET    /privacy/export        (everyone)
 *   Export organisation data  GET    /privacy/org-export    (owner / admin)
 *   Delete my account         DELETE /privacy/account       (password; double confirm)
 *   Delete organisation       DELETE /privacy/org           (owner; password + org name; double confirm)
 *
 * `installPrivacyTab(contentRoot, deps)` adds the tab button and its section to
 * the existing Settings page DOM (so the page module keeps one tab system) and
 * self-manages activation: clicking any other tab hides this one. All DOM is
 * built with `el()`; server text only ever lands in `textContent`.
 */

import { el } from '@pinpoint/shared';

import { apiFetch as defaultApiFetch, apiFetchBlob as defaultApiFetchBlob, ApiError } from '../lib/api';
import { clearAuth } from '../lib/auth';
import { navigate as defaultNavigate } from '../lib/router';
import { showToast } from './Toast';

export interface PrivacyDeps {
  apiFetch?: typeof defaultApiFetch;
  apiFetchBlob?: typeof defaultApiFetchBlob;
  navigate?: (path: string) => void;
  /** Triggers the browser download of a blob (injectable for tests). */
  download?: (blob: Blob, filename: string) => void;
}

export interface PrivacyTabHandle {
  /** Show the Privacy section (and load roles on first use). */
  activate(): Promise<void>;
  deactivate(): void;
  dispose(): void;
}

type Role = 'owner' | 'admin' | 'member' | 'viewer' | null;

const BTN = 'padding: 8px 14px; border-radius: 4px; border: 1px solid var(--pp-border-medium); background: var(--pp-bg-tertiary); cursor: pointer; font-size: 13px;';
const DANGER = 'padding: 8px 14px; border-radius: 4px; border: none; background: var(--pp-error, #b91c1c); color: #fff; cursor: pointer; font-size: 13px;';
const INPUT = 'display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px; border: 1px solid var(--pp-input-border); border-radius: 4px; font-size: 14px;';
const CARD = 'border: 1px solid var(--pp-border-light); border-radius: 8px; padding: 16px; margin-bottom: 16px; background: var(--pp-bg-primary);';

function defaultDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url });
  a.setAttribute('download', filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

interface Field {
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

function field(id: string, text: string, type = 'text', autocomplete = 'off'): Field {
  const input = el('input', { id, type, autocomplete, 'data-role': id });
  input.style.cssText = INPUT;
  const label = el('label', { for: id }, [text, input]);
  label.style.cssText = 'display: block; font-size: 13px; margin-bottom: 10px;';
  return { label, input };
}

/**
 * A two-step destructive action: step 1 reveals the confirmation panel,
 * step 2 requires the re-authentication inputs AND an explicit "I understand"
 * tick before the final button enables.
 */
function destructiveCard(opts: {
  role: string;
  title: string;
  description: string[];
  startLabel: string;
  finalLabel: string;
  extra?: Field[];
  passwordLabel: string;
  onConfirm: (ctx: { secret: string; extra: string[] }) => Promise<void>;
}): { root: HTMLElement; reset(): void } {
  const message = el('p', { role: 'alert', hidden: true, 'data-role': `${opts.role}-error` });
  message.style.cssText = 'color: var(--pp-error-text); font-size: 13px; margin: 8px 0 0;';

  const secret = field(`${opts.role}-password`, opts.passwordLabel, 'password', 'current-password');
  const ack = el('input', { type: 'checkbox', id: `${opts.role}-ack`, 'data-role': `${opts.role}-ack` });
  const ackLabel = el('label', { for: `${opts.role}-ack` }, [ack, ' I understand this is permanent and cannot be undone.']);
  ackLabel.style.cssText = 'display: block; font-size: 13px; margin: 6px 0 12px;';
  const final = el('button', { type: 'button', disabled: true, 'data-role': `${opts.role}-confirm` }, opts.finalLabel);
  final.style.cssText = DANGER;
  const cancel = el('button', { type: 'button', 'data-role': `${opts.role}-cancel` }, 'Cancel');
  cancel.style.cssText = BTN;
  const buttons = el('div', {}, [final, ' ', cancel]);
  const panel = el('div', { hidden: true, 'data-role': `${opts.role}-panel` }, [
    ...(opts.extra ?? []).map((f) => f.label),
    secret.label,
    ackLabel,
    buttons,
  ]);
  panel.style.marginTop = '12px';
  const start = el('button', { type: 'button', 'data-role': `${opts.role}-start` }, opts.startLabel);
  start.style.cssText = DANGER;

  const root = el('section', { 'data-role': `${opts.role}-card` }, [
    el('h2', {}, opts.title),
    ...opts.description.map((d) => el('p', {}, d)),
    start,
    panel,
    message,
  ]);
  root.style.cssText = CARD + ' border-color: var(--pp-error-border, #fca5a5);';
  (root.querySelector('h2') as HTMLElement).style.cssText = 'margin: 0 0 8px; font-size: 16px;';
  for (const p of root.querySelectorAll('p:not([role])')) (p as HTMLElement).style.cssText = 'margin: 0 0 10px; font-size: 13px; color: var(--pp-text-secondary);';

  const sync = (): void => {
    const filled = secret.input.value.length > 0 && (opts.extra ?? []).every((f) => f.input.value.trim().length > 0);
    final.disabled = !(ack.checked && filled);
  };
  secret.input.addEventListener('input', sync);
  ack.addEventListener('change', sync);
  for (const f of opts.extra ?? []) f.input.addEventListener('input', sync);

  const reset = (): void => {
    panel.hidden = true;
    start.hidden = false;
    message.hidden = true;
    message.textContent = '';
    secret.input.value = '';
    ack.checked = false;
    for (const f of opts.extra ?? []) f.input.value = '';
    sync();
  };
  start.addEventListener('click', () => {
    start.hidden = true;
    panel.hidden = false;
    (opts.extra?.[0]?.input ?? secret.input).focus();
  });
  cancel.addEventListener('click', reset);
  final.addEventListener('click', () => {
    if (final.disabled) return;
    final.disabled = true;
    message.hidden = true;
    opts
      .onConfirm({ secret: secret.input.value, extra: (opts.extra ?? []).map((f) => f.input.value) })
      .catch((err: unknown) => {
        message.textContent = errorText(err);
        message.hidden = false;
        sync();
      });
  });
  return { root, reset };
}

export function installPrivacyTab(contentRoot: HTMLElement, deps: PrivacyDeps = {}): PrivacyTabHandle | null {
  const apiFetch = deps.apiFetch ?? defaultApiFetch;
  const apiFetchBlob = deps.apiFetchBlob ?? defaultApiFetchBlob;
  const navigate = deps.navigate ?? defaultNavigate;
  const download = deps.download ?? defaultDownload;

  const tabs = contentRoot.querySelector<HTMLElement>('[data-role="tabs"]');
  const anchorSection = contentRoot.querySelector<HTMLElement>('[data-section]');
  if (!tabs || !anchorSection?.parentElement) return null;
  const sectionsParent = anchorSection.parentElement;

  // ---- Tab button ----------------------------------------------------------
  const button = el('button', { type: 'button', 'data-role': 'tab-privacy' }, 'Privacy');
  button.style.cssText = 'padding: 8px 16px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--pp-text-secondary); font-weight: 400; cursor: pointer; font-size: 14px;';
  tabs.appendChild(button);

  // ---- Section -------------------------------------------------------------
  const status = el('p', { role: 'status', 'data-role': 'privacy-status', hidden: true });
  status.style.cssText = 'font-size: 13px; margin: 0 0 12px;';
  const exportMine = el('button', { type: 'button', 'data-role': 'export-mine' }, 'Export my data');
  exportMine.style.cssText = BTN;
  const exportOrg = el('button', { type: 'button', 'data-role': 'export-org' }, 'Export organisation data');
  exportOrg.style.cssText = BTN;
  const exportOrgNote = el('p', { 'data-role': 'export-org-note' }, 'Organisation owners and admins can download everything the organisation holds: projects, pages, annotations, comments, members, portals and rules.');
  const exportCard = el('section', { 'data-role': 'export-card' }, [
    el('h2', {}, 'Your data'),
    el('p', {}, 'Download a JSON copy of your personal data and the content you wrote, across every organisation you belong to. Large exports are capped; the file says "truncated": true if anything was left out.'),
    exportMine,
    el('div', { 'data-role': 'org-export-wrap', hidden: true }, [exportOrgNote, exportOrg]),
  ]);
  exportCard.style.cssText = CARD;
  (exportCard.querySelector('h2') as HTMLElement).style.cssText = 'margin: 0 0 8px; font-size: 16px;';
  for (const p of exportCard.querySelectorAll('p')) (p as HTMLElement).style.cssText = 'margin: 0 0 10px; font-size: 13px; color: var(--pp-text-secondary);';
  (exportCard.querySelector('[data-role="org-export-wrap"]') as HTMLElement).style.marginTop = '16px';

  const accountCard = destructiveCard({
    role: 'delete-account',
    title: 'Delete my account',
    description: [
      'Deletes your profile, sign-in, sessions and notifications. Organisations that contain only you are deleted with all their data and screenshots.',
      'What you wrote in an organisation that continues to exist stays in its project history, attributed to “Deleted user”.',
      'If you are the only owner of an organisation that has other members, transfer ownership first.',
    ],
    startLabel: 'Delete my account…',
    finalLabel: 'Permanently delete my account',
    passwordLabel: 'Password (if you sign in with Google/GitHub and have no password, type your account e-mail instead)',
    onConfirm: async ({ secret }) => {
      await apiFetch('/privacy/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: secret, confirmEmail: secret }),
      });
      clearAuth();
      showToast({ message: 'Your account was deleted.', variant: 'success' });
      navigate('/auth');
    },
  });

  const orgNameField = field('delete-org-name', 'Type the organisation name to confirm');
  let orgName = '';
  const orgCard = destructiveCard({
    role: 'delete-org',
    title: 'Delete organisation',
    description: [
      'Permanently deletes this organisation and everything in it — projects, annotations, comments, screenshots, members’ access, portals, integrations, webhooks and API keys. Export the data first.',
      'An organisation with an active paid subscription cannot be deleted until the subscription is cancelled.',
    ],
    startLabel: 'Delete organisation…',
    finalLabel: 'Permanently delete the organisation',
    extra: [orgNameField],
    passwordLabel: 'Your password (or your account e-mail if you have none)',
    onConfirm: async ({ secret, extra }) => {
      await apiFetch('/privacy/org', {
        method: 'DELETE',
        body: JSON.stringify({ password: secret, confirmEmail: secret, confirmName: extra[0] ?? '' }),
      });
      clearAuth();
      showToast({ message: `Organisation${orgName ? ` “${orgName}”` : ''} deleted. Log in again to continue.`, variant: 'success' });
      navigate('/auth');
    },
  });
  orgCard.root.hidden = true;

  const section = el('section', { 'data-section': 'privacy', hidden: true }, [
    el('p', {}, [
      'How we handle your data is described in the ',
      Object.assign(el('a', { href: '/legal/privacy' }, 'Privacy Policy'), { }),
      '. These tools let you exercise your rights to access, portability and erasure (GDPR, POPIA, CCPA).',
    ]),
    status,
    exportCard,
    accountCard.root,
    orgCard.root,
  ]);
  (section.querySelector('a') as HTMLAnchorElement).setAttribute('data-route', '');
  (section.firstElementChild as HTMLElement).style.cssText = 'font-size: 13px; margin: 0 0 16px;';
  sectionsParent.appendChild(section);

  // ---- Behaviour -------------------------------------------------------------
  function setStatus(text: string, tone: 'info' | 'error' = 'info'): void {
    status.textContent = text;
    status.hidden = text === '';
    status.style.color = tone === 'error' ? 'var(--pp-error-text)' : 'var(--pp-text-primary)';
  }

  async function runExport(path: string, btn: HTMLButtonElement, fallbackName: string): Promise<void> {
    btn.disabled = true;
    setStatus('Preparing your download…');
    try {
      const { blob, filename } = await apiFetchBlob(path);
      download(blob, filename ?? fallbackName);
      let note = 'Download started.';
      try {
        const head = await blob.slice(Math.max(0, blob.size - 64)).text();
        if (/"truncated":true/.test(head)) note = 'Download started. The export hit the size cap and is marked "truncated": true — contact us for a complete offline export.';
      } catch {
        // size hint is best-effort
      }
      setStatus(note);
    } catch (err) {
      setStatus(errorText(err), 'error');
    } finally {
      btn.disabled = false;
    }
  }
  exportMine.addEventListener('click', () => void runExport('/privacy/export', exportMine, 'pinpoint-my-data.json'));
  exportOrg.addEventListener('click', () => void runExport('/privacy/org-export', exportOrg, 'pinpoint-org-data.json'));

  let role: Role = null;
  let loaded = false;
  async function loadRole(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const me = await apiFetch<{ user?: { id: string }; id?: string }>('/users/me');
      const myId = me.user?.id ?? me.id;
      const members = await apiFetch<{ data: Array<{ userId: string; role: Role }> }>('/org/members');
      role = members.data.find((m) => m.userId === myId)?.role ?? null;
      if (role === 'owner') {
        const org = await apiFetch<{ org: { name: string } }>('/org');
        orgName = org.org?.name ?? '';
        orgCard.root.hidden = false;
      }
    } catch {
      // Role discovery is a UX nicety: the server enforces every permission.
    }
    (exportCard.querySelector('[data-role="org-export-wrap"]') as HTMLElement).hidden = !(role === 'owner' || role === 'admin');
  }

  const otherButtons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b !== button);
  function paint(active: boolean): void {
    button.style.borderBottom = active ? '2px solid var(--pp-accent)' : '2px solid transparent';
    button.style.color = active ? 'var(--pp-accent-text)' : 'var(--pp-text-secondary)';
    button.style.fontWeight = active ? '600' : '400';
  }
  function deactivate(): void {
    section.hidden = true;
    paint(false);
  }
  async function activate(): Promise<void> {
    // Hide every other section and un-paint the other tab buttons.
    for (const s of Array.from(sectionsParent.querySelectorAll<HTMLElement>(':scope > [data-section]'))) {
      if (s !== section) s.hidden = true;
    }
    for (const b of otherButtons) {
      b.style.borderBottom = '2px solid transparent';
      b.style.color = 'var(--pp-text-secondary)';
      b.style.fontWeight = '400';
    }
    section.hidden = false;
    paint(true);
    await loadRole();
  }
  button.addEventListener('click', () => void activate());
  for (const b of otherButtons) b.addEventListener('click', deactivate);

  return {
    activate,
    deactivate,
    dispose() {
      for (const b of otherButtons) b.removeEventListener('click', deactivate);
      button.remove();
      section.remove();
      accountCard.reset();
      orgCard.reset();
    },
  };
}
// Re-exported so tests can reference the error type used by apiFetch.
export { ApiError };
