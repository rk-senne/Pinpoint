/**
 * IntegrationsPage — dashboard page for managing third-party integrations (Task 5).
 */

import { mountAppLayout } from '../components/AppLayout';
import { apiFetch } from '../lib/api';
import { cloneTemplate } from '../lib/render';

const PROVIDERS = ['slack', 'jira', 'linear', 'github'] as const;

interface IntegrationEntry {
  id: string;
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export function mountIntegrationsPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  const fragment = cloneTemplate('tpl-integrations-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  const teardownLayout = mountAppLayout(rootEl, contentRoot);
  const grid = contentRoot.querySelector<HTMLElement>('[data-role="integrations-grid"]')!;

  let integrations: IntegrationEntry[] = [];

  async function load(): Promise<void> {
    try {
      const res = await apiFetch<{ integrations: IntegrationEntry[] }>('/integrations');
      integrations = res.integrations;
    } catch {
      integrations = [];
    }
    render();
  }

  function render(): void {
    grid.innerHTML = '';
    for (const provider of PROVIDERS) {
      const entry = integrations.find((i) => i.provider === provider);
      const card = document.createElement('div');
      card.style.cssText = 'border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 10px;';

      const connected = !!entry?.enabled;
      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <strong style="font-size: 14px; text-transform: capitalize;">${provider}</strong>
          <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: ${connected ? '#dcfce7' : '#f3f4f6'}; color: ${connected ? '#16a34a' : '#6b7280'};">${connected ? 'Connected' : 'Disconnected'}</span>
        </div>
        ${entry ? `<div style="font-size: 12px; color: #6b7280;">Config: ${Object.keys(entry.config).join(', ') || 'default'}</div>` : ''}
        <div style="display: flex; gap: 8px; margin-top: auto;">
          ${!connected ? `<button data-connect="${provider}" style="padding: 6px 12px; background: #4f46e5; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Connect</button>` : `<button data-disconnect="${provider}" style="padding: 6px 12px; background: #dc2626; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Disconnect</button>`}
        </div>
      `;
      grid.appendChild(card);
    }

    // Bind button events
    grid.querySelectorAll<HTMLButtonElement>('[data-connect]').forEach((btn) => {
      btn.addEventListener('click', () => void connect(btn.dataset.connect!));
    });
    grid.querySelectorAll<HTMLButtonElement>('[data-disconnect]').forEach((btn) => {
      btn.addEventListener('click', () => void disconnect(btn.dataset.disconnect!));
    });
  }

  async function connect(provider: string): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}/connect`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch { /* render shows current state */ }
  }

  async function disconnect(provider: string): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}`, { method: 'DELETE' });
      await load();
    } catch { /* render shows current state */ }
  }

  void load();

  return () => {
    teardownLayout();
    contentRoot.remove();
  };
}
