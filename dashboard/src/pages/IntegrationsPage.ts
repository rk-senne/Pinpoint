/**
 * IntegrationsPage — dashboard page for managing third-party integrations (Task 5).
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './IntegrationsPage.templates.html?raw';
import { mountAppLayout } from '../components/AppLayout';
import { showToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { cloneTemplate } from '../lib/render';
import { el, setText, BRAND_COLORS, STATUS_PILL_COLORS } from '@pinpoint/shared';

/** Brand-correct display names (CSS `capitalize` produced "Github"). */
const PROVIDER_LABELS: Record<string, string> = {
  slack: 'Slack',
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub',
};

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
  registerTemplates('IntegrationsPage', templatesHtml);
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
    grid.replaceChildren();
    for (const provider of PROVIDERS) {
      const entry = integrations.find((i) => i.provider === provider);
      const connected = !!entry?.enabled;

      const card = document.createElement('div');
      card.style.cssText =
        'border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 10px;';

      // Header row: provider name + status pill.
      const header = document.createElement('div');
      header.style.cssText = 'display: flex; align-items: center; gap: 10px;';

      const name = el('strong', {}, PROVIDER_LABELS[provider] ?? provider);
      name.style.cssText = 'font-size: 14px;';

      const pill = el('span', {}, connected ? 'Connected' : 'Disconnected');
      pill.style.cssText =
        `font-size: 11px; padding: 2px 8px; border-radius: 10px; background: ${
          connected ? STATUS_PILL_COLORS.positive.bg : STATUS_PILL_COLORS.neutral.bg
        }; color: ${connected ? BRAND_COLORS.success : 'var(--pp-text-secondary)'};`;

      header.append(name, pill);
      card.appendChild(header);

      // Optional config summary — config keys come from the API, so build
      // via DOM/textContent (never innerHTML).
      if (entry) {
        const config = el(
          'div',
          {},
          `Config: ${Object.keys(entry.config).join(', ') || 'default'}`,
        );
        config.style.cssText = `font-size: 12px; color: ${BRAND_COLORS.muted};`;
        card.appendChild(config);
      }

      // Action row: connect / disconnect button.
      const actions = document.createElement('div');
      actions.style.cssText = 'display: flex; gap: 8px; margin-top: auto;';

      const btn = document.createElement('button');
      if (connected) {
        btn.dataset.disconnect = provider;
        setText(btn, 'Disconnect');
        btn.style.cssText =
          `padding: 6px 12px; background: ${BRAND_COLORS.danger}; color: ${BRAND_COLORS.onBrand}; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;`;
        btn.addEventListener('click', () => void disconnect(provider));
      } else {
        btn.dataset.connect = provider;
        setText(btn, 'Connect');
        btn.style.cssText =
          `padding: 6px 12px; background: ${BRAND_COLORS.primary}; color: ${BRAND_COLORS.onBrand}; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;`;
        btn.addEventListener('click', () => void connect(provider));
      }

      actions.appendChild(btn);
      card.appendChild(actions);
      grid.appendChild(card);
    }
  }

  async function connect(provider: string): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}/connect`, { method: 'POST', body: JSON.stringify({}) });
      showToast({ message: 'Integration connected', variant: 'success' });
      await load();
    } catch { /* render shows current state */ }
  }

  async function disconnect(provider: string): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}`, { method: 'DELETE' });
      showToast({ message: 'Integration disconnected', variant: 'success' });
      await load();
    } catch { /* render shows current state */ }
  }

  void load();

  return () => {
    teardownLayout();
    contentRoot.remove();
  };
}
