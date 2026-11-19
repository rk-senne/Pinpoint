/**
 * IntegrationsPage — dashboard page for managing third-party integrations (Task 5).
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './IntegrationsPage.templates.html?raw';
import { mountAppLayout } from '../components/AppLayout';
import { showToast } from '../components/Toast';
import { ApiError, apiFetch } from '../lib/api';
import { cloneTemplate } from '../lib/render';
import { el, setText, BRAND_COLORS, STATUS_PILL_COLORS } from '@pinpoint/shared';

/** Brand-correct display names (CSS `capitalize` produced "Github"). */
const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
  clickup: 'ClickUp',
  asana: 'Asana',
  slack: 'Slack',
};

/** Task trackers first; Slack can be connected but nothing delivers to it yet. */
const PROVIDERS = ['github', 'jira', 'linear', 'clickup', 'asana', 'slack'] as const;

/**
 * Config keys a tracker needs before "Send to…" can create tasks (mirrors the
 * server adapters). Providers absent here (Slack) have no delivery target.
 */
const REQUIRED_CONFIG: Record<string, string[]> = {
  github: ['owner', 'repo'],
  jira: ['cloudId', 'projectKey'],
  linear: ['teamId'],
  clickup: ['listId'],
  asana: ['projectGid'],
};

/** Human-readable messages for the `?error=<code>` the OAuth callback redirects with. */
const OAUTH_ERRORS: Record<string, string> = {
  OAUTH_DENIED: 'The provider did not grant access. Nothing was connected.',
  OAUTH_EXCHANGE_FAILED: 'The provider rejected the authorization. Check the OAuth app credentials and redirect URI, then try again.',
  INTEGRATION_NOT_CONFIGURED: 'This provider is not configured on the server.',
};

/** Indirection so tests can observe the OAuth hand-off without navigating jsdom. */
export const navigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

interface IntegrationEntry {
  id: string;
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface TargetOption {
  id: string;
  label: string;
  config: Record<string, string>;
}

type SetupState =
  | { provider: string; status: 'loading' }
  | { provider: string; status: 'error'; message: string }
  | { provider: string; status: 'ready'; targets: TargetOption[] };

function needsSetup(provider: string, entry: IntegrationEntry | undefined): boolean {
  const required = REQUIRED_CONFIG[provider];
  if (!required || !entry?.enabled) return false;
  return required.some((k) => typeof entry.config[k] !== 'string' || entry.config[k] === '');
}

function notConfiguredMessage(provider: string): string {
  return `Ask your admin to configure ${PROVIDER_LABELS[provider] ?? provider} — see INTEGRATIONS_SETUP.md`;
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
  let setup: SetupState | null = null;
  /** Per-provider inline notices (e.g. "not configured"), cleared on the next attempt. */
  const notices = new Map<string, { text: string; role: string }>();
  let disposed = false;

  async function load(): Promise<void> {
    try {
      const res = await apiFetch<{ integrations: IntegrationEntry[] }>('/integrations');
      integrations = res.integrations;
    } catch {
      integrations = [];
    }
    if (!disposed) render();
  }

  const buttonCss = (bg: string): string =>
    `padding: 6px 12px; background: ${bg}; color: ${BRAND_COLORS.onBrand}; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;`;

  function renderSetupPanel(provider: string, state: SetupState): HTMLElement {
    const panel = el('div', { 'data-role': 'setup-panel' });
    panel.dataset.provider = provider;
    panel.style.cssText =
      'display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px dashed #e5e7eb; border-radius: 6px;';

    if (state.status === 'loading') {
      const msg = el('span', { 'data-role': 'setup-loading' });
      setText(msg, `Loading ${PROVIDER_LABELS[provider] ?? provider} targets…`);
      panel.appendChild(msg);
    } else if (state.status === 'error') {
      const msg = el('span', { 'data-role': 'setup-error', role: 'alert' });
      setText(msg, state.message);
      msg.style.color = BRAND_COLORS.danger;
      panel.appendChild(msg);
    } else if (state.targets.length === 0) {
      const msg = el('span', { 'data-role': 'setup-empty' });
      setText(msg, `No targets found for this ${PROVIDER_LABELS[provider] ?? provider} account.`);
      panel.appendChild(msg);
    } else {
      const label = el('label', {});
      setText(label, 'Send feedback to');
      label.style.cssText = 'font-size: 12px; font-weight: 600;';
      const select = document.createElement('select');
      select.dataset.role = 'target-select';
      select.setAttribute('aria-label', `${PROVIDER_LABELS[provider] ?? provider} target`);
      select.style.cssText = 'padding: 6px; font-size: 12px; max-width: 100%;';
      state.targets.forEach((t, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        setText(opt, t.label);
        select.appendChild(opt);
      });
      const save = document.createElement('button');
      save.type = 'button';
      save.dataset.role = 'target-save';
      setText(save, 'Save');
      save.style.cssText = buttonCss(BRAND_COLORS.primary);
      save.addEventListener('click', () => {
        const chosen = state.targets[Number(select.value)];
        if (chosen) void saveTarget(provider, chosen);
      });
      panel.append(label, select, save);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.role = 'setup-cancel';
    setText(cancel, 'Cancel');
    cancel.style.cssText = 'align-self: flex-start; padding: 4px 10px; font-size: 12px; cursor: pointer;';
    cancel.addEventListener('click', () => {
      setup = null;
      render();
    });
    panel.appendChild(cancel);
    return panel;
  }

  function render(): void {
    grid.replaceChildren();
    for (const provider of PROVIDERS) {
      const entry = integrations.find((i) => i.provider === provider);
      const connected = !!entry?.enabled;
      const label = PROVIDER_LABELS[provider] ?? provider;

      const card = document.createElement('div');
      card.dataset.provider = provider;
      card.style.cssText =
        'border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 10px;';

      // Header row: provider name + status pill.
      const header = document.createElement('div');
      header.style.cssText = 'display: flex; align-items: center; gap: 10px;';

      const name = el('strong', {}, label);
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

      const notice = notices.get(provider);
      if (notice) {
        const n = el('div', { 'data-role': notice.role, role: 'alert' });
        setText(n, notice.text);
        n.style.cssText = `font-size: 12px; color: ${BRAND_COLORS.danger};`;
        card.appendChild(n);
      }

      const incomplete = needsSetup(provider, entry);
      if (incomplete && setup?.provider !== provider) {
        const hint = el('div', { 'data-role': 'setup-hint' });
        setText(hint, `Connected, but not finished: choose where ${label} tasks are created.`);
        hint.style.cssText = 'font-size: 12px;';
        card.appendChild(hint);
      }
      if (setup && setup.provider === provider) card.appendChild(renderSetupPanel(provider, setup));

      // Action row: connect / disconnect button (+ finish / change target).
      const actions = document.createElement('div');
      actions.style.cssText = 'display: flex; gap: 8px; margin-top: auto;';

      if (connected && REQUIRED_CONFIG[provider] && setup?.provider !== provider) {
        const setupBtn = document.createElement('button');
        setupBtn.type = 'button';
        setupBtn.dataset.setup = provider;
        setText(setupBtn, incomplete ? 'Finish setup' : 'Change target');
        setupBtn.style.cssText = buttonCss(BRAND_COLORS.primary);
        setupBtn.addEventListener('click', () => void openSetup(provider));
        actions.appendChild(setupBtn);
      }

      const btn = document.createElement('button');
      if (connected) {
        btn.dataset.disconnect = provider;
        setText(btn, 'Disconnect');
        btn.style.cssText = buttonCss(BRAND_COLORS.danger);
        btn.addEventListener('click', () => void disconnect(provider));
      } else {
        btn.dataset.connect = provider;
        setText(btn, 'Connect');
        btn.style.cssText = buttonCss(BRAND_COLORS.primary);
        btn.addEventListener('click', () => void connect(provider));
      }

      actions.appendChild(btn);
      card.appendChild(actions);
      grid.appendChild(card);
    }
  }

  async function connect(provider: string): Promise<void> {
    notices.delete(provider);
    try {
      const res = await apiFetch<{ redirectUrl?: string }>(`/integrations/${provider}/connect`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res?.redirectUrl) {
        // Hand the browser to the provider; the callback returns to /integrations?connected=…
        navigation.assign(res.redirectUrl);
        return;
      }
      // Without a redirect nothing was connected — don't claim otherwise.
      notices.set(provider, { text: 'The server did not start the sign-in flow. Try again.', role: 'connect-error' });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 501 || err.code === 'INTEGRATION_NOT_CONFIGURED')) {
        notices.set(provider, { text: notConfiguredMessage(provider), role: 'connect-not-configured' });
      }
      /* other errors were already toasted by apiFetch */
    }
    if (!disposed) render();
  }

  async function disconnect(provider: string): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}`, { method: 'DELETE' });
      showToast({ message: 'Integration disconnected', variant: 'success' });
      if (setup?.provider === provider) setup = null;
      await load();
    } catch { /* render shows current state */ }
  }

  async function openSetup(provider: string): Promise<void> {
    const mine: SetupState = { provider, status: 'loading' };
    setup = mine;
    render();
    try {
      const res = await apiFetch<{ targets: TargetOption[] }>(`/integrations/${provider}/targets`);
      if (setup !== mine || disposed) return;
      setup = { provider, status: 'ready', targets: res.targets ?? [] };
    } catch (err) {
      if (setup !== mine || disposed) return;
      setup = {
        provider,
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load targets.',
      };
    }
    render();
  }

  async function saveTarget(provider: string, target: TargetOption): Promise<void> {
    try {
      await apiFetch(`/integrations/${provider}`, {
        method: 'PATCH',
        body: JSON.stringify({ config: target.config }),
      });
    } catch {
      return; // apiFetch toasted the validation / server error; keep the picker open
    }
    showToast({ message: `${PROVIDER_LABELS[provider] ?? provider} is ready — feedback will go to ${target.label}`, variant: 'success' });
    setup = null;
    await load();
  }

  /** Handle the redirect back from the OAuth callback (`?connected=` / `?error=`). */
  function handleOAuthReturn(): string | null {
    const q = new URLSearchParams(window.location.search);
    const connectedProvider = q.get('connected');
    const errorCode = q.get('error');
    if (!connectedProvider && !errorCode) return null;
    // Strip the one-shot params so a refresh doesn't replay the message.
    history.replaceState(null, '', window.location.pathname);

    if (errorCode) {
      const errProvider = q.get('provider');
      const text =
        errorCode === 'INTEGRATION_NOT_CONFIGURED' && errProvider && errProvider in PROVIDER_LABELS
          ? notConfiguredMessage(errProvider)
          : OAUTH_ERRORS[errorCode] ?? 'Connecting the integration failed.';
      showToast({ message: text, variant: 'error' });
      return null;
    }
    if (connectedProvider && (PROVIDERS as readonly string[]).includes(connectedProvider)) {
      showToast({ message: `${PROVIDER_LABELS[connectedProvider]} connected`, variant: 'success' });
      return REQUIRED_CONFIG[connectedProvider] ? connectedProvider : null;
    }
    return null;
  }

  const justConnected = handleOAuthReturn();
  void load().then(() => {
    // Straight into "Finish setup" when the callback left the target undecided.
    if (justConnected && !disposed) {
      const entry = integrations.find((i) => i.provider === justConnected);
      if (needsSetup(justConnected, entry)) void openSetup(justConnected);
    }
  });

  return () => {
    disposed = true;
    teardownLayout();
    contentRoot.remove();
  };
}
