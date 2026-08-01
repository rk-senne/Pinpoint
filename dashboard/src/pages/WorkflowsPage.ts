/**
 * WorkflowsPage — dashboard page for managing automation rules and SLA policies.
 */

import { mountAppLayout } from '../components/AppLayout';
import { apiFetch } from '../lib/api';
import { bindEvents, cloneTemplate } from '../lib/render';

interface AutomationRule {
  id: string;
  name: string;
  trigger_event: string;
  action_type: string;
  active: boolean;
}

interface SlaPolicy {
  id: string;
  name: string;
  severity: string;
  response_time_hours: number;
  resolution_time_hours: number;
}

export function mountWorkflowsPage(
  rootEl: HTMLElement,
  _params: Record<string, string>,
): () => void {
  const fragment = cloneTemplate('tpl-workflows-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  const rulesList = contentRoot.querySelector<HTMLElement>('[data-role="rules-list"]')!;
  const ruleForm = contentRoot.querySelector<HTMLElement>('[data-role="rule-form"]')!;
  const slaList = contentRoot.querySelector<HTMLElement>('[data-role="sla-list"]')!;
  const slaForm = contentRoot.querySelector<HTMLElement>('[data-role="sla-form"]')!;

  const cleanupEvents = bindEvents(contentRoot, {
    'create-rule': () => {
      ruleForm.hidden = !ruleForm.hidden;
    },
    'submit-rule': () => void submitRule(),
    'create-sla': () => {
      slaForm.hidden = !slaForm.hidden;
    },
    'submit-sla': () => void submitSla(),
  });

  async function fetchRules(): Promise<void> {
    try {
      const { rules } = await apiFetch<{ rules: AutomationRule[] }>('/workflows/rules');
      renderRules(rules);
    } catch { /* best-effort */ }
  }

  async function fetchSla(): Promise<void> {
    try {
      const { policies } = await apiFetch<{ policies: SlaPolicy[] }>('/workflows/sla');
      renderSla(policies);
    } catch { /* best-effort */ }
  }

  function renderRules(rules: AutomationRule[]): void {
    if (!rules.length) {
      rulesList.innerHTML = '<p style="padding:12px;color:#888;font-size:13px;margin:0;">No rules configured.</p>';
      return;
    }
    rulesList.replaceChildren();
    for (const rule of rules) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;';
      row.innerHTML = `<span><strong>${esc(rule.name)}</strong> — ${esc(rule.trigger_event)} → ${esc(rule.action_type)}</span><span style="color:${rule.active ? '#38a169' : '#a0aec0'}">${rule.active ? '● Active' : '○ Inactive'}</span>`;
      rulesList.appendChild(row);
    }
  }

  function renderSla(policies: SlaPolicy[]): void {
    if (!policies.length) {
      slaList.innerHTML = '<p style="padding:12px;color:#888;font-size:13px;margin:0;">No SLA policies configured.</p>';
      return;
    }
    slaList.replaceChildren();
    for (const p of policies) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;';
      row.innerHTML = `<span><strong>${esc(p.name)}</strong> — ${esc(p.severity)}</span><span>Response: ${p.response_time_hours}h · Resolution: ${p.resolution_time_hours}h</span>`;
      slaList.appendChild(row);
    }
  }

  async function submitRule(): Promise<void> {
    const name = contentRoot.querySelector<HTMLInputElement>('[data-role="rule-name"]')!.value.trim();
    const triggerEvent = contentRoot.querySelector<HTMLSelectElement>('[data-role="rule-trigger"]')!.value;
    const actionType = contentRoot.querySelector<HTMLSelectElement>('[data-role="rule-action"]')!.value;
    const paramsRaw = contentRoot.querySelector<HTMLTextAreaElement>('[data-role="rule-params"]')!.value.trim();
    if (!name) return;
    let actionParams: Record<string, unknown> = {};
    try { actionParams = paramsRaw ? JSON.parse(paramsRaw) : {}; } catch { return; }

    await apiFetch('/workflows/rules', {
      method: 'POST',
      body: JSON.stringify({ name, triggerEvent, actionType, actionParams }),
    });
    ruleForm.hidden = true;
    void fetchRules();
  }

  async function submitSla(): Promise<void> {
    const name = contentRoot.querySelector<HTMLInputElement>('[data-role="sla-name"]')!.value.trim();
    const severity = contentRoot.querySelector<HTMLSelectElement>('[data-role="sla-severity"]')!.value;
    const responseTimeHours = Number(contentRoot.querySelector<HTMLInputElement>('[data-role="sla-response"]')!.value);
    const resolutionTimeHours = Number(contentRoot.querySelector<HTMLInputElement>('[data-role="sla-resolution"]')!.value);
    if (!name || !responseTimeHours || !resolutionTimeHours) return;

    await apiFetch('/workflows/sla', {
      method: 'POST',
      body: JSON.stringify({ name, severity, responseTimeHours, resolutionTimeHours }),
    });
    slaForm.hidden = true;
    void fetchSla();
  }

  void fetchRules();
  void fetchSla();

  return () => {
    cleanupEvents();
    teardownLayout();
    contentRoot.remove();
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
