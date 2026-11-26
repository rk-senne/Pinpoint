// @vitest-environment jsdom
/**
 * WorkflowsPage.test.ts — rendering (XSS-inert text, snake_case rows), empty
 * states, create / toggle / rename / delete flows and validation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountWorkflowsPage } from './WorkflowsPage';
import { _resetLazyTemplatesForTests } from '../lib/lazyTemplates';
import { resetStores } from '../lib/stores';

const SHELL_TEMPLATES: Record<string, string> = {
  'app-layout': `
    <div class="fl-app-layout">
      <header><span data-slot="currentUser"></span>
        <button type="button" data-action="logout">Logout</button></header>
      <div><aside data-slot="sidebar"></aside><main data-slot="content"></main></div>
    </div>`,
  'tpl-project-list-sidebar': `
    <div data-role="root">
      <button type="button" data-action="selectActive" data-role="tab-active">active</button>
      <button type="button" data-action="selectArchived" data-role="tab-archived">archived</button>
      <input type="text" data-action="input:search" data-role="search" />
      <div data-role="list"></div>
      <button type="button" data-action="openCreate" data-role="create">+ Create</button>
    </div>`,
};

interface Call { method: string; url: string; body: unknown }
let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubApi(state: { rules: unknown[]; sla: unknown[]; failRules?: boolean; breaches?: unknown[]; failBreaches?: boolean }): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && url.includes('/workflows/rules')) {
        return Promise.resolve(state.failRules ? json({ error: { message: 'boom' } }, 500) : json({ data: state.rules }));
      }
      if (method === 'GET' && url.includes('/workflows/sla/breaches')) {
        return Promise.resolve(
          state.failBreaches
            ? json({ error: { message: 'boom' } }, 500)
            : json({ data: state.breaches ?? [], pagination: { total: (state.breaches ?? []).length } }),
        );
      }
      if (method === 'GET' && url.includes('/workflows/sla')) return Promise.resolve(json({ data: state.sla }));
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({ ok: true }, method === 'POST' ? 201 : 200));
    }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(): { root: HTMLElement; teardown: () => void } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, teardown: mountWorkflowsPage(root, {}) };
}

const click = (el: Element | null): void => (el as HTMLElement).click();
const q = <T extends HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;

const RULE = {
  id: 'r1',
  name: 'Assign critical bugs',
  active: true,
  trigger_event: 'annotation.created',
  action_type: 'assign',
  action_params: { assigneeId: 'u1' },
  conditions: { severity: 'critical' },
  priority: 1,
  project_id: null,
};

beforeEach(() => {
  document.body.innerHTML = '';
  _resetLazyTemplatesForTests();
  for (const [id, html] of Object.entries(SHELL_TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
  resetStores();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const XSS = '<img src=x onerror=alert(1)>';

describe('WorkflowsPage — rendering', () => {
  it('renders a malicious rule name as inert text and labels snake_case rows', async () => {
    stubApi({ rules: [{ ...RULE, name: XSS }], sla: [] });
    const { root, teardown } = mount();
    await flush();

    const list = q(root, '[data-role="rules-list"]');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain(XSS);
    expect(list.textContent).toContain('Annotation created → Assign');
    expect(list.textContent).toContain('if severity = critical');
    expect(list.textContent).toContain('Active');
    expect(q(list, '[data-role="rule-toggle"]').getAttribute('aria-checked')).toBe('true');
    teardown();
  });

  it('renders a malicious SLA name as inert text with humanised durations', async () => {
    stubApi({
      rules: [],
      sla: [{ id: 's1', name: XSS, severity: 'major', response_time_hours: 1, resolution_time_hours: 72 }],
    });
    const { root, teardown } = mount();
    await flush();

    const list = q(root, '[data-role="sla-list"]');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain(XSS);
    expect(list.textContent).toContain('Respond within 1 hour · resolve within 3 days');
    teardown();
  });

  it('shows the shared empty state (with a CTA that opens the form) for both lists', async () => {
    stubApi({ rules: [], sla: [] });
    const { root, teardown } = mount();
    await flush();

    const rules = q(root, '[data-role="rules-list"]');
    expect(rules.querySelector('.pp-empty-state')).not.toBeNull();
    expect(rules.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(rules.textContent).toContain('No automation rules');
    expect(q(root, '[data-role="sla-list"]').textContent).toContain('No SLA policies');

    expect(q(root, '[data-role="rule-form"]').hidden).toBe(true);
    click(rules.querySelector('.pp-empty-state__cta'));
    expect(q(root, '[data-role="rule-form"]').hidden).toBe(false);
    teardown();
  });

  it('shows a retryable error instead of silently rendering nothing', async () => {
    stubApi({ rules: [], sla: [], failRules: true });
    const { root, teardown } = mount();
    await flush();
    const list = q(root, '[data-role="rules-list"]');
    expect(list.textContent).toContain('Couldn’t load automation rules.');
    expect(list.querySelector('[role="alert"] button')).not.toBeNull();
    teardown();
  });
});

describe('WorkflowsPage — rule flows', () => {
  it('validates name and JSON before posting', async () => {
    stubApi({ rules: [], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-rule-btn"]'));
    const form = q<HTMLFormElement>(root, '[data-role="rule-form"]');

    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(q(root, '[data-role="rule-name-error"]').textContent).toContain('name');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    q<HTMLInputElement>(root, '[data-role="rule-name"]').value = 'Bad json';
    q<HTMLTextAreaElement>(root, '[data-role="rule-params"]').value = '{nope';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(q(root, '[data-role="rule-params-error"]').textContent).toContain('valid JSON');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    teardown();
  });

  it('POSTs a new rule, closes + resets the form and reloads the list', async () => {
    stubApi({ rules: [], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-rule-btn"]'));
    q<HTMLInputElement>(root, '[data-role="rule-name"]').value = '  Notify on resolve ';
    q<HTMLSelectElement>(root, '[data-role="rule-action"]').value = 'notify';
    q<HTMLTextAreaElement>(root, '[data-role="rule-params"]').value = '{"channel":"email"}';
    q<HTMLFormElement>(root, '[data-role="rule-form"]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/workflows/rules');
    expect(post.body).toEqual({
      name: 'Notify on resolve',
      triggerEvent: 'annotation.created',
      actionType: 'notify',
      actionParams: { channel: 'email' },
    });
    expect(q(root, '[data-role="rule-form"]').hidden).toBe(true);
    expect(q<HTMLInputElement>(root, '[data-role="rule-name"]').value).toBe('');
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/workflows/rules')).length).toBe(2);
    teardown();
  });

  it('sends a severity condition only when one is chosen', async () => {
    stubApi({ rules: [], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-rule-btn"]'));
    q<HTMLInputElement>(root, '[data-role="rule-name"]').value = 'Crit only';
    q<HTMLSelectElement>(root, '[data-role="rule-severity"]').value = 'critical';
    q<HTMLTextAreaElement>(root, '[data-role="rule-params"]').value = '{"assigneeId":"u1"}';
    q<HTMLFormElement>(root, '[data-role="rule-form"]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as Record<string, unknown>).conditions).toEqual({ severity: 'critical' });
    teardown();
  });

  it('toggles a rule with PATCH', async () => {
    stubApi({ rules: [RULE], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="rule-toggle"]'));
    await flush();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/workflows/rules/r1');
    expect(patch.body).toEqual({ active: false });
    expect(q(root, '[data-role="rule-toggle"]').getAttribute('aria-checked')).toBe('false');
    expect(q(root, '[data-role="rules-list"]').textContent).toContain('Inactive');
    teardown();
  });

  it('renames a rule inline', async () => {
    stubApi({ rules: [RULE], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="rule-edit"]'));
    const input = q<HTMLInputElement>(root, '[data-role="rule-edit-input"]');
    expect(input.value).toBe('Assign critical bugs');
    input.value = 'Escalate criticals';
    click(q(root, '[data-role="rule-edit-save"]'));
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Escalate criticals' });
    expect(q(root, '[data-role="rules-list"]').textContent).toContain('Escalate criticals');
    teardown();
  });

  it('deletes only after an explicit confirmation, handling the 204 response', async () => {
    stubApi({ rules: [RULE], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="rule-delete"]'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    click(q(root, '[data-role="rule-delete-confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('/workflows/rules/r1');
    expect(q(root, '[data-role="rules-list"]').textContent).toContain('No automation rules');
    teardown();
  });
});

describe('WorkflowsPage — SLA flows', () => {
  it('rejects a resolution time shorter than the response time', async () => {
    stubApi({ rules: [], sla: [] });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-sla-btn"]'));
    q<HTMLInputElement>(root, '[data-role="sla-name"]').value = 'Odd';
    q<HTMLInputElement>(root, '[data-role="sla-response"]').value = '10';
    q<HTMLInputElement>(root, '[data-role="sla-resolution"]').value = '2';
    q<HTMLFormElement>(root, '[data-role="sla-form"]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(q(root, '[data-role="sla-form-error"]').textContent).toContain('cannot be shorter');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    teardown();
  });

  it('creates and deletes a policy', async () => {
    stubApi({
      rules: [],
      sla: [{ id: 's1', name: 'Crit', severity: 'critical', response_time_hours: 1, resolution_time_hours: 8 }],
    });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-sla-btn"]'));
    q<HTMLInputElement>(root, '[data-role="sla-name"]').value = 'Major';
    q<HTMLSelectElement>(root, '[data-role="sla-severity"]').value = 'major';
    q<HTMLInputElement>(root, '[data-role="sla-response"]').value = '4';
    q<HTMLInputElement>(root, '[data-role="sla-resolution"]').value = '48';
    q<HTMLFormElement>(root, '[data-role="sla-form"]').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      name: 'Major',
      severity: 'major',
      responseTimeHours: 4,
      resolutionTimeHours: 48,
    });

    click(q(root, '[data-role="sla-delete"]'));
    click(q(root, '[data-role="sla-delete-confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('/workflows/sla/s1');
    teardown();
  });
});

describe('WorkflowsPage — SLA breaches panel', () => {
  const BREACH = {
    id: 'b1',
    annotation_id: 'a1',
    sla_policy_id: 'p1',
    breach_type: 'response',
    breached_at: '2026-11-10T10:00:00.000Z',
    body: XSS,
    severity: 'critical',
    status: 'active',
  };

  it('lists breaches as inert text with type, severity and a count', async () => {
    stubApi({ rules: [], sla: [], breaches: [BREACH] });
    const { root, teardown } = mount();
    await flush();
    const list = q(root, '[data-role="breach-list"]');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain(XSS);
    expect(list.textContent).toContain('Response SLA missed');
    expect(list.querySelectorAll('[data-role="breach-row"]')).toHaveLength(1);
    expect(q(root, '[data-role="breach-count"]').textContent).toBe('1');
    expect(calls.some((c) => c.url.includes('/workflows/sla/breaches'))).toBe(true);
    teardown();
  });

  it('shows a friendly empty state when nothing is breached', async () => {
    stubApi({ rules: [], sla: [], breaches: [] });
    const { root, teardown } = mount();
    await flush();
    expect(q(root, '[data-role="breach-empty"]').textContent).toMatch(/No SLA breaches/);
    expect(q(root, '[data-role="breach-count"]').hidden).toBe(true);
    teardown();
  });

  it('shows a retryable error when the breaches request fails', async () => {
    stubApi({ rules: [], sla: [], failBreaches: true });
    const { root, teardown } = mount();
    await flush();
    const list = q(root, '[data-role="breach-list"]');
    expect(list.querySelector('[role="alert"]')?.textContent).toContain('SLA breaches');
    teardown();
  });
});
