/**
 * SendToMenu — C4 "Send to…" action for an annotation detail view.
 *
 * Renders a button that, when opened, lists the org's connected task-tracker
 * integrations (GitHub / Linear / Jira / ClickUp / Asana) fetched from
 * `GET /integrations`. Picking one POSTs `/annotations/:id/deliver` and shows
 * the resulting external issue link inline; a transient failure surfaces a
 * toast and leaves a "Retry" affordance (re-POST is idempotent server-side).
 *
 * Every piece of dynamic data — provider names, issue URLs, error strings —
 * is written through `el()` / `setText()` from `@pinpoint/shared/safeText`,
 * never `innerHTML`, so an untrusted external URL or error message can't
 * inject markup. Colors come from the shared theme tokens.
 *
 * The component builds its own DOM (no `<template>` dependency) so it can be
 * mounted additively into the ProjectView detail section without touching
 * `dashboard/index.html`.
 */

import { el, setText, BRAND_COLORS } from '@pinpoint/shared';
import { apiFetch as defaultApiFetch } from '../lib/api';
import { showToast } from './Toast';

/** The task-tracker providers that support one-click delivery. */
export const DELIVERABLE_PROVIDERS = ['github', 'linear', 'jira', 'clickup', 'asana'] as const;
export type DeliverableProvider = (typeof DELIVERABLE_PROVIDERS)[number];

const PROVIDER_LABELS: Record<DeliverableProvider, string> = {
  github: 'GitHub',
  linear: 'Linear',
  jira: 'Jira',
  clickup: 'ClickUp',
  asana: 'Asana',
};

interface IntegrationSummary {
  provider: string;
  enabled?: boolean;
}

interface ExternalLink {
  provider: string;
  externalId: string | null;
  externalUrl: string | null;
  status: string;
  lastError: string | null;
}

export interface SendToMenuOptions {
  /** The annotation to deliver. */
  annotationId: string;
  /** Injectable fetch shim so tests can stub the API. */
  apiFetch?: typeof defaultApiFetch;
  /** Injectable toast so tests can assert on error feedback. */
  toast?: typeof showToast;
}

/** Is a provider name one we can deliver to? */
function isDeliverable(p: string): p is DeliverableProvider {
  return (DELIVERABLE_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Mount the Send-to menu into `container`. Returns a teardown that removes
 * the component and its document-level listeners.
 */
export function mountSendToMenu(container: HTMLElement, options: SendToMenuOptions): () => void {
  const api = options.apiFetch ?? defaultApiFetch;
  const toast = options.toast ?? showToast;
  const { annotationId } = options;

  const root = el('div', { class: 'send-to-menu', 'data-role': 'send-to-menu' });

  const button = el('button', { type: 'button', class: 'send-to-menu__button', 'data-role': 'send-to-button' });
  setText(button, 'Send to…');
  button.style.cssText =
    `padding:6px 12px;border-radius:6px;border:1px solid ${BRAND_COLORS.primary};` +
    `background:${BRAND_COLORS.primary};color:#fff;font-size:13px;font-weight:600;cursor:pointer;`;

  const menu = el('ul', { class: 'send-to-menu__list', 'data-role': 'send-to-list', role: 'menu' });
  menu.hidden = true;
  menu.style.cssText =
    'list-style:none;margin:4px 0 0;padding:4px;border:1px solid #e5e7eb;border-radius:6px;' +
    'background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.1);min-width:180px;position:absolute;z-index:50;';

  const result = el('div', { class: 'send-to-menu__result', 'data-role': 'send-to-result' });
  result.style.cssText = 'margin-top:6px;font-size:13px;';

  root.append(button, menu, result);

  let open = false;
  let delivering = false;

  function closeMenu(): void {
    open = false;
    menu.hidden = true;
  }

  async function loadProviders(): Promise<void> {
    menu.replaceChildren();
    const loading = el('li', { role: 'none' });
    setText(loading, 'Loading…');
    loading.style.cssText = 'padding:6px 10px;color:#6b7280;';
    menu.appendChild(loading);

    let integrations: IntegrationSummary[] = [];
    try {
      const resp = await api<{ integrations: IntegrationSummary[] }>('/integrations');
      integrations = resp.integrations ?? [];
    } catch {
      // apiFetch already toasts the error envelope.
      menu.replaceChildren();
      const err = el('li', { role: 'none' });
      setText(err, 'Could not load integrations.');
      err.style.cssText = 'padding:6px 10px;color:#b91c1c;';
      menu.appendChild(err);
      return;
    }

    const connected = integrations.filter((i) => isDeliverable(i.provider) && i.enabled !== false);
    menu.replaceChildren();

    if (connected.length === 0) {
      const empty = el('li', { role: 'none', 'data-role': 'send-to-empty' });
      setText(empty, 'No task trackers connected. Connect one in Settings → Integrations.');
      empty.style.cssText = 'padding:6px 10px;color:#6b7280;max-width:220px;';
      menu.appendChild(empty);
      return;
    }

    for (const integration of connected) {
      const provider = integration.provider as DeliverableProvider;
      const item = el('li', { role: 'none' });
      const action = el('button', { type: 'button', role: 'menuitem', 'data-role': 'send-to-option' });
      action.dataset.provider = provider;
      setText(action, PROVIDER_LABELS[provider]);
      action.style.cssText =
        'display:block;width:100%;text-align:left;padding:6px 10px;border:none;background:none;' +
        'font-size:13px;cursor:pointer;border-radius:4px;';
      action.addEventListener('click', () => void deliver(provider));
      item.appendChild(action);
      menu.appendChild(item);
    }
  }

  async function deliver(provider: DeliverableProvider): Promise<void> {
    if (delivering) return;
    delivering = true;
    closeMenu();

    const pending = el('span', { 'data-role': 'send-to-pending' });
    setText(pending, `Creating ${PROVIDER_LABELS[provider]} task…`);
    pending.style.color = '#6b7280';
    result.replaceChildren(pending);

    try {
      const resp = await api<{ link: ExternalLink }>(
        `/annotations/${encodeURIComponent(annotationId)}/deliver`,
        { method: 'POST', body: JSON.stringify({ provider }) },
      );
      renderLink(resp.link);
      toast({ message: `Created a ${PROVIDER_LABELS[provider]} task.`, variant: 'success' });
    } catch (err) {
      // apiFetch surfaces the envelope toast; add an inline retry affordance.
      const message =
        (err as { message?: string }).message ?? `Could not deliver to ${PROVIDER_LABELS[provider]}.`;
      renderFailure(provider, message);
    } finally {
      delivering = false;
    }
  }

  function renderLink(link: ExternalLink): void {
    result.replaceChildren();
    if (link.externalUrl) {
      const label = el('span');
      setText(label, `${PROVIDER_LABELS[link.provider as DeliverableProvider] ?? link.provider}: `);
      const anchor = el('a', {
        href: link.externalUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        'data-role': 'send-to-link',
      });
      // `target`/`rel` are not in the safeText allow-list; set them directly on
      // an element whose href was already validated by `el`'s isSafeUrl gate.
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      setText(anchor, link.externalId ? `#${link.externalId}` : 'View task');
      anchor.style.color = BRAND_COLORS.primary;
      result.append(label, anchor);
    } else {
      const span = el('span');
      setText(span, 'Delivered.');
      result.appendChild(span);
    }
  }

  function renderFailure(provider: DeliverableProvider, message: string): void {
    result.replaceChildren();
    const err = el('span', { 'data-role': 'send-to-error' });
    setText(err, message);
    err.style.color = '#b91c1c';
    const retry = el('button', { type: 'button', 'data-role': 'send-to-retry' });
    setText(retry, 'Retry');
    retry.style.cssText = 'margin-left:8px;font-size:12px;cursor:pointer;';
    retry.addEventListener('click', () => void deliver(provider));
    result.append(err, retry);
  }

  button.addEventListener('click', () => {
    open = !open;
    menu.hidden = !open;
    if (open) void loadProviders();
  });

  const onDocClick = (e: MouseEvent): void => {
    if (open && !root.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('click', onDocClick, true);

  container.appendChild(root);

  return () => {
    document.removeEventListener('click', onDocClick, true);
    root.remove();
  };
}
