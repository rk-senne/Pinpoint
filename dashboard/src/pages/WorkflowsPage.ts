/**
 * WorkflowsPage — manage automation rules and SLA policies.
 *
 *   Rules: list, create, rename, enable/disable (PATCH), delete.
 *   SLA:   list, create, delete.
 *
 * The API returns raw snake_case rows; `lib/automationFormat.ts` normalises
 * them. All user-supplied text is rendered through `el`/`setText` (inert).
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './WorkflowsPage.templates.html?raw';
import { el, setText } from '@pinpoint/shared';
import { mountAppLayout } from '../components/AppLayout';
import { createEmptyState } from '../components/EmptyState';
import { showToast } from '../components/Toast';
import { ApiError, apiFetch } from '../lib/api';
import {
  ACTION_PARAM_HINTS,
  actionLabel,
  describeConditions,
  formatHours,
  normalizeRule,
  normalizeBreach,
  normalizeSla,
  breachTypeLabel,
  type SlaBreach,
  parseActionParams,
  triggerLabel,
  validateSla,
  type AutomationRule,
  type SlaPolicy,
} from '../lib/automationFormat';
import { bindEvents, cloneTemplate, requireRole } from '../lib/render';
import { projectsStore } from '../lib/stores';

const PAGE_QS = '?page=1&pageSize=100';

export function mountWorkflowsPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  registerTemplates('WorkflowsPage', templatesHtml);
  const fragment = cloneTemplate('tpl-workflows-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  const rulesList = requireRole(contentRoot, 'rules-list');
  const slaList = requireRole(contentRoot, 'sla-list');
  const breachList = requireRole(contentRoot, 'breach-list');
  const breachCount = requireRole(contentRoot, 'breach-count');
  const ruleForm = requireRole(contentRoot, 'rule-form') as HTMLFormElement;
  const slaForm = requireRole(contentRoot, 'sla-form') as HTMLFormElement;
  const ruleToggleBtn = contentRoot.querySelector<HTMLButtonElement>('[data-role="create-rule-btn"]');
  const slaToggleBtn = contentRoot.querySelector<HTMLButtonElement>('[data-role="create-sla-btn"]');

  const q = <T extends HTMLElement>(role: string): T => requireRole(contentRoot, role) as T;
  const ruleName = q<HTMLInputElement>('rule-name');
  const ruleTrigger = q<HTMLSelectElement>('rule-trigger');
  const ruleAction = q<HTMLSelectElement>('rule-action');
  const ruleParams = q<HTMLTextAreaElement>('rule-params');
  const ruleParamsHint = q('rule-params-hint');
  const ruleNameError = q('rule-name-error');
  const ruleParamsError = q('rule-params-error');
  const ruleFormError = q('rule-form-error');
  const slaName = q<HTMLInputElement>('sla-name');
  const slaSeverity = q<HTMLSelectElement>('sla-severity');
  const slaResponse = q<HTMLInputElement>('sla-response');
  const slaResolution = q<HTMLInputElement>('sla-resolution');
  const slaFormError = q('sla-form-error');

  let rules: AutomationRule[] = [];
  let policies: SlaPolicy[] = [];
  let rulesState: 'loading' | 'ready' | 'error' = 'loading';
  let slaState: 'loading' | 'ready' | 'error' = 'loading';
  let breaches: SlaBreach[] = [];
  let breachTotal = 0;
  let breachState: 'loading' | 'ready' | 'error' = 'loading';
  let editingRuleId: string | null = null;
  let confirmingId: string | null = null;
  let disposed = false;

  // --- helpers -----------------------------------------------------------
  function showError(node: HTMLElement, message: string): void {
    setText(node, message);
    node.hidden = false;
  }
  function clearError(node: HTMLElement): void {
    node.textContent = '';
    node.hidden = true;
  }
  function openForm(form: HTMLElement, button: HTMLButtonElement | null, open: boolean): void {
    form.hidden = !open;
    button?.setAttribute('aria-expanded', String(open));
    if (open) form.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }
  function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiError || err instanceof Error ? err.message : fallback;
  }
  function projectName(id: string | null): string {
    if (!id) return 'All projects';
    return projectsStore.list.get().find((p) => p.id === id)?.name ?? 'Project removed';
  }
  function loadFailed(retry: () => void, what: string): HTMLElement {
    const retryBtn = el('button', { type: 'button', class: 'pp-btn pp-btn--secondary' }, 'Retry');
    retryBtn.addEventListener('click', retry);
    return el('div', { class: 'pp-load-error', role: 'alert' }, [
      el('span', {}, `Couldn’t load ${what}.`),
      retryBtn,
    ]);
  }

  // --- param hint --------------------------------------------------------
  function syncParamsHint(): void {
    const hint = ACTION_PARAM_HINTS[ruleAction.value] ?? '{}';
    setText(ruleParamsHint, `Example: ${hint}`);
    ruleParams.placeholder = hint;
  }
  syncParamsHint();
  ruleAction.addEventListener('change', syncParamsHint);

  // --- rendering ---------------------------------------------------------
  function renderRules(): void {
    rulesList.replaceChildren();
    if (rulesState === 'error') {
      rulesList.appendChild(loadFailed(() => void fetchRules(), 'automation rules'));
      return;
    }
    if (rulesState === 'loading') return;
    if (rules.length === 0) {
      rulesList.appendChild(
        createEmptyState('no-rules', { onCta: () => openForm(ruleForm, ruleToggleBtn, true) }),
      );
      return;
    }
    const wrap = el('ul', { class: 'pp-rows' });
    for (const rule of rules) wrap.appendChild(renderRuleRow(rule));
    rulesList.appendChild(wrap);
  }

  function renderRuleRow(rule: AutomationRule): HTMLElement {
    const li = el('li', { class: 'pp-row', 'data-role': 'rule-row' });
    li.setAttribute('data-id', rule.id);

    const main = el('div', { class: 'pp-row__main' });
    if (editingRuleId === rule.id) {
      const input = el('input', { type: 'text', class: 'pp-row__edit', value: rule.name, 'aria-label': 'Rule name', 'data-role': 'rule-edit-input' });
      input.value = rule.name;
      const save = el('button', { type: 'button', class: 'pp-btn pp-btn--primary pp-btn--sm', 'data-role': 'rule-edit-save' }, 'Save');
      const cancel = el('button', { type: 'button', class: 'pp-btn pp-btn--secondary pp-btn--sm' }, 'Cancel');
      const commit = (): void => void renameRule(rule, input.value);
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { editingRuleId = null; renderRules(); }
      });
      cancel.addEventListener('click', () => { editingRuleId = null; renderRules(); });
      main.append(el('div', { class: 'pp-row__edit-line' }, [input, save, cancel]));
      queueMicrotask(() => input.focus());
    } else {
      main.appendChild(el('div', { class: 'pp-row__title' }, rule.name));
    }
    const conditions = describeConditions(rule.conditions);
    main.appendChild(
      el('div', { class: 'pp-row__meta' }, [
        `${triggerLabel(rule.triggerEvent)} → ${actionLabel(rule.actionType)}`,
        conditions ? ` · if ${conditions}` : '',
        ` · ${projectName(rule.projectId)}`,
      ]),
    );

    const actions = el('div', { class: 'pp-row__actions' });
    const toggle = el('button', {
      type: 'button',
      role: 'switch',
      class: 'pp-switch',
      'aria-label': `${rule.name}: ${rule.active ? 'active' : 'inactive'}`,
      'data-role': 'rule-toggle',
    });
    toggle.setAttribute('aria-checked', String(rule.active));
    toggle.appendChild(el('span', { class: 'pp-switch__thumb', 'aria-hidden': 'true' }));
    toggle.addEventListener('click', () => void setRuleActive(rule, !rule.active));
    actions.append(
      toggle,
      el('span', { class: `pp-badge ${rule.active ? 'pp-badge--positive' : 'pp-badge--neutral'}` }, rule.active ? 'Active' : 'Inactive'),
    );
    if (editingRuleId !== rule.id) {
      const edit = el('button', { type: 'button', class: 'pp-btn pp-btn--ghost pp-btn--sm', 'aria-label': `Rename ${rule.name}`, 'data-role': 'rule-edit' }, 'Rename');
      edit.addEventListener('click', () => { editingRuleId = rule.id; confirmingId = null; renderRules(); });
      actions.appendChild(edit);
    }
    actions.appendChild(deleteControl(rule.id, rule.name, () => deleteRule(rule), 'rule'));

    li.append(main, actions);
    return li;
  }

  /** Two-step inline delete: "Delete" → "Confirm delete" / "Cancel". */
  function deleteControl(id: string, name: string, run: () => Promise<void>, kind: 'rule' | 'sla'): HTMLElement {
    const box = el('span', { class: 'pp-row__confirm' });
    if (confirmingId === id) {
      const yes = el('button', { type: 'button', class: 'pp-btn pp-btn--danger pp-btn--sm', 'data-role': `${kind}-delete-confirm` }, 'Confirm delete');
      const no = el('button', { type: 'button', class: 'pp-btn pp-btn--secondary pp-btn--sm' }, 'Cancel');
      yes.addEventListener('click', () => void run());
      no.addEventListener('click', () => { confirmingId = null; rerender(kind); });
      box.append(yes, no);
      queueMicrotask(() => yes.focus());
    } else {
      const del = el('button', { type: 'button', class: 'pp-btn pp-btn--ghost-danger pp-btn--sm', 'aria-label': `Delete ${name}`, 'data-role': `${kind}-delete` }, 'Delete');
      del.addEventListener('click', () => { confirmingId = id; rerender(kind); });
      box.appendChild(del);
    }
    return box;
  }

  function rerender(kind: 'rule' | 'sla'): void {
    if (kind === 'rule') renderRules();
    else renderSla();
  }

  function renderSla(): void {
    slaList.replaceChildren();
    if (slaState === 'error') {
      slaList.appendChild(loadFailed(() => void fetchSla(), 'SLA policies'));
      return;
    }
    if (slaState === 'loading') return;
    if (policies.length === 0) {
      slaList.appendChild(
        createEmptyState('no-sla', { onCta: () => openForm(slaForm, slaToggleBtn, true) }),
      );
      return;
    }
    const wrap = el('ul', { class: 'pp-rows' });
    for (const p of policies) {
      const li = el('li', { class: 'pp-row', 'data-role': 'sla-row' });
      li.setAttribute('data-id', p.id);
      const main = el('div', { class: 'pp-row__main' }, [
        el('div', { class: 'pp-row__title' }, p.name),
        el('div', { class: 'pp-row__meta' }, `Respond within ${formatHours(p.responseTimeHours)} · resolve within ${formatHours(p.resolutionTimeHours)}`),
      ]);
      const actions = el('div', { class: 'pp-row__actions' }, [
        el('span', { class: `pp-badge pp-badge--sev-${p.severity}` }, p.severity),
        deleteControl(p.id, p.name, () => deleteSla(p), 'sla'),
      ]);
      li.append(main, actions);
      wrap.appendChild(li);
    }
    slaList.appendChild(wrap);
  }

  function renderBreaches(): void {
    breachList.replaceChildren();
    breachCount.hidden = breachState !== 'ready' || breachTotal === 0;
    setText(breachCount, String(breachTotal));
    if (breachState === 'error') {
      breachList.appendChild(loadFailed(() => void fetchBreaches(), 'SLA breaches'));
      return;
    }
    if (breachState === 'loading') return;
    if (breaches.length === 0) {
      breachList.appendChild(el('p', { class: 'pp-field__hint', 'data-role': 'breach-empty' }, 'No SLA breaches — every tracked item is within its target.'));
      return;
    }
    const wrap = el('ul', { class: 'pp-rows' });
    for (const b of breaches) {
      const li = el('li', { class: 'pp-row', 'data-role': 'breach-row' });
      li.setAttribute('data-id', b.id);
      const when = b.breachedAt && !Number.isNaN(Date.parse(b.breachedAt)) ? new Date(b.breachedAt).toLocaleString() : '';
      li.append(
        el('div', { class: 'pp-row__main' }, [
          el('div', { class: 'pp-row__title' }, b.excerpt || '(no text)'),
          el('div', { class: 'pp-row__meta' }, `${breachTypeLabel(b.breachType)}${when ? ` · ${when}` : ''} · ${b.status}`),
        ]),
        el('div', { class: 'pp-row__actions' }, [el('span', { class: `pp-badge pp-badge--sev-${b.severity}` }, b.severity)]),
      );
      wrap.appendChild(li);
    }
    breachList.appendChild(wrap);
  }

  // --- data --------------------------------------------------------------
  async function fetchBreaches(): Promise<void> {
    try {
      const { data, pagination } = await apiFetch<{ data: Array<Record<string, unknown>>; pagination?: { total?: number } }>(
        '/workflows/sla/breaches?page=1&pageSize=25',
      );
      if (disposed) return;
      breaches = data.map(normalizeBreach);
      breachTotal = pagination?.total ?? breaches.length;
      breachState = 'ready';
    } catch {
      if (disposed) return;
      breachState = 'error';
    }
    renderBreaches();
  }

  async function fetchRules(): Promise<void> {
    try {
      const { data } = await apiFetch<{ data: Array<Record<string, unknown>> }>(`/workflows/rules${PAGE_QS}`);
      if (disposed) return;
      rules = data.map(normalizeRule);
      rulesState = 'ready';
    } catch {
      if (disposed) return;
      rulesState = 'error';
    }
    renderRules();
  }

  async function fetchSla(): Promise<void> {
    try {
      const { data } = await apiFetch<{ data: Array<Record<string, unknown>> }>(`/workflows/sla${PAGE_QS}`);
      if (disposed) return;
      policies = data.map(normalizeSla);
      slaState = 'ready';
    } catch {
      if (disposed) return;
      slaState = 'error';
    }
    renderSla();
  }

  async function submitRule(): Promise<void> {
    clearError(ruleNameError);
    clearError(ruleParamsError);
    clearError(ruleFormError);
    const name = ruleName.value.trim();
    if (!name) {
      showError(ruleNameError, 'Give the rule a name.');
      ruleName.focus();
      return;
    }
    const params = parseActionParams(ruleParams.value);
    if (!params.ok) {
      showError(ruleParamsError, params.error);
      ruleParams.focus();
      return;
    }
    try {
      await apiFetch('/workflows/rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          triggerEvent: ruleTrigger.value,
          actionType: ruleAction.value,
          actionParams: params.value,
        }),
      });
    } catch (err) {
      showError(ruleFormError, errorMessage(err, 'Could not save the rule.'));
      return;
    }
    showToast({ message: 'Rule created', variant: 'success' });
    ruleForm.reset();
    syncParamsHint();
    openForm(ruleForm, ruleToggleBtn, false);
    await fetchRules();
  }

  async function submitSla(): Promise<void> {
    clearError(slaFormError);
    const input = {
      name: slaName.value,
      responseTimeHours: Number(slaResponse.value),
      resolutionTimeHours: Number(slaResolution.value),
    };
    const problem = validateSla(input);
    if (problem) {
      showError(slaFormError, problem);
      return;
    }
    try {
      await apiFetch('/workflows/sla', {
        method: 'POST',
        body: JSON.stringify({
          name: input.name.trim(),
          severity: slaSeverity.value,
          responseTimeHours: input.responseTimeHours,
          resolutionTimeHours: input.resolutionTimeHours,
        }),
      });
    } catch (err) {
      showError(slaFormError, errorMessage(err, 'Could not save the policy.'));
      return;
    }
    showToast({ message: 'SLA policy created', variant: 'success' });
    slaForm.reset();
    openForm(slaForm, slaToggleBtn, false);
    await fetchSla();
  }

  async function patchRule(rule: AutomationRule, patch: Record<string, unknown>): Promise<boolean> {
    try {
      await apiFetch(`/workflows/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return true;
    } catch {
      return false; // apiFetch already toasted the server message
    }
  }

  async function setRuleActive(rule: AutomationRule, active: boolean): Promise<void> {
    if (!(await patchRule(rule, { active }))) return;
    rule.active = active;
    renderRules();
  }

  async function renameRule(rule: AutomationRule, next: string): Promise<void> {
    const name = next.trim();
    if (!name) { showToast({ message: 'A rule needs a name.', variant: 'warning' }); return; }
    if (name === rule.name) { editingRuleId = null; renderRules(); return; }
    if (!(await patchRule(rule, { name }))) return;
    rule.name = name;
    editingRuleId = null;
    showToast({ message: 'Rule renamed', variant: 'success' });
    renderRules();
  }

  async function deleteRule(rule: AutomationRule): Promise<void> {
    try {
      await apiFetch(`/workflows/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
    } catch {
      return;
    }
    confirmingId = null;
    rules = rules.filter((r) => r.id !== rule.id);
    showToast({ message: 'Rule deleted', variant: 'success' });
    renderRules();
  }

  async function deleteSla(policy: SlaPolicy): Promise<void> {
    try {
      await apiFetch(`/workflows/sla/${encodeURIComponent(policy.id)}`, { method: 'DELETE' });
    } catch {
      return;
    }
    confirmingId = null;
    policies = policies.filter((p) => p.id !== policy.id);
    showToast({ message: 'SLA policy deleted', variant: 'success' });
    renderSla();
  }

  // --- wiring ------------------------------------------------------------
  const cleanupEvents = bindEvents(contentRoot, {
    'create-rule': () => openForm(ruleForm, ruleToggleBtn, ruleForm.hidden),
    'cancel-rule': () => openForm(ruleForm, ruleToggleBtn, false),
    'submit-rule': (e) => { e.preventDefault(); void submitRule(); },
    'create-sla': () => openForm(slaForm, slaToggleBtn, slaForm.hidden),
    'cancel-sla': () => openForm(slaForm, slaToggleBtn, false),
    'submit-sla': (e) => { e.preventDefault(); void submitSla(); },
  });

  void fetchRules();
  void fetchSla();
  void fetchBreaches();

  return () => {
    disposed = true;
    ruleAction.removeEventListener('change', syncParamsHint);
    cleanupEvents();
    teardownLayout();
    contentRoot.remove();
  };
}
