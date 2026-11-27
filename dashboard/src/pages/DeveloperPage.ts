/**
 * DeveloperPage (`/developer`) — org API keys and the org audit log.
 *
 *   GET/POST /api/v1/api-keys, DELETE /api/v1/api-keys/:id
 *   GET      /api/v1/org/audit-log?actionPrefix=…
 *
 * The raw `pk_…` key is returned by the API exactly once; it is shown once
 * here and never stored. All server strings are written as text nodes.
 */

import { el, setText } from '@pinpoint/shared';

import { mountAppLayout } from '../components/AppLayout';
import { apiFetch } from '../lib/api';

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  keyType: string;
  scopes: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
}

interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  resourceType: string;
  createdAt: string;
}

const CARD = 'background: var(--pp-bg-primary); border: 1px solid var(--pp-border-light); border-radius: 8px; padding: 16px; margin-bottom: 20px;';
const INPUT = 'padding: 6px 8px; border: 1px solid var(--pp-border-medium); border-radius: 4px; font-size: 13px;';
const BTN = 'padding: 6px 14px; background: var(--pp-accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;';

export function mountDeveloperPage(rootEl: HTMLElement): () => void {
  const keysBody = el('tbody', { 'data-role': 'api-key-rows' });
  const created = el('div', { 'data-role': 'api-key-created', role: 'status', hidden: true, style: 'margin-top: 12px; font-size: 13px;' });
  const nameInput = el('input', { type: 'text', 'aria-label': 'Key name', placeholder: 'Key name (e.g. CI triage bot)', 'data-role': 'api-key-name', style: `${INPUT} min-width: 260px;` });
  const createForm = el('form', { 'data-role': 'api-key-form', style: 'display: flex; gap: 8px; margin-bottom: 12px;' }, [
    nameInput,
    el('button', { type: 'submit', style: BTN }, 'Create key'),
  ]);

  const prefixInput = el('input', { type: 'text', 'aria-label': 'Action prefix', placeholder: 'Action prefix, e.g. api_key.', 'data-role': 'audit-prefix', style: `${INPUT} min-width: 260px;` });
  const auditForm = el('form', { 'data-role': 'audit-form', style: 'display: flex; gap: 8px; margin-bottom: 12px;' }, [
    prefixInput,
    el('button', { type: 'submit', style: BTN }, 'Filter'),
  ]);
  const auditBody = el('tbody', { 'data-role': 'audit-rows' });
  const auditEmpty = el('p', { 'data-role': 'audit-empty', hidden: true, style: 'font-size: 13px; color: var(--pp-text-secondary);' }, 'No matching events.');

  const th = (label: string): HTMLElement => el('th', { scope: 'col', style: 'text-align: left; padding: 6px 8px; font-size: 12px;' }, label);
  const content = el('div', { 'data-role': 'root', style: 'max-width: 860px; margin: 0 auto; padding: 24px;' }, [
    el('h1', { style: 'margin: 0 0 16px; font-size: 20px;' }, 'Developer'),
    el('section', { 'aria-labelledby': 'dev-keys-h', style: CARD }, [
      el('h2', { id: 'dev-keys-h', style: 'margin: 0 0 6px; font-size: 16px;' }, 'API keys'),
      el('p', { style: 'margin: 0 0 12px; font-size: 13px; color: var(--pp-text-secondary);' }, 'Keys let scripts and agents read and write feedback (projects, annotations, comments). The key is shown once.'),
      createForm,
      created,
      el('table', { style: 'width: 100%; border-collapse: collapse; margin-top: 12px;' }, [
        el('thead', {}, el('tr', {}, [th('Name'), th('Key'), th('Scopes'), th('Status'), th('')])),
        keysBody,
      ]),
    ]),
    el('section', { 'aria-labelledby': 'dev-audit-h', style: CARD }, [
      el('h2', { id: 'dev-audit-h', style: 'margin: 0 0 6px; font-size: 16px;' }, 'Audit log'),
      auditForm,
      auditEmpty,
      el('table', { style: 'width: 100%; border-collapse: collapse;' }, [
        el('thead', {}, el('tr', {}, [th('When'), th('Action'), th('Actor'), th('Resource')])),
        auditBody,
      ]),
    ]),
  ]);
  const teardownLayout = mountAppLayout(rootEl, content);
  let disposed = false;

  const td = (value: string | Node): HTMLElement => el('td', { style: 'padding: 6px 8px; font-size: 13px; border-top: 1px solid var(--pp-border-light);' }, value);

  async function loadKeys(): Promise<void> {
    const res = await apiFetch<{ data: ApiKeyRow[] }>('/api-keys');
    if (disposed) return;
    keysBody.replaceChildren();
    for (const k of res.data) {
      const revoked = k.revokedAt !== null;
      const revoke = el('button', { type: 'button', 'aria-label': `Revoke ${k.name}`, 'data-action': 'revoke', style: 'padding: 3px 10px; font-size: 12px; cursor: pointer;' }, 'Revoke');
      revoke.addEventListener('click', () => {
        void apiFetch(`/api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' }).then(loadKeys);
      });
      keysBody.appendChild(
        el('tr', { 'data-key-id': k.id }, [
          td(k.name),
          td(`${k.keyPrefix}…`),
          td(k.scopes.join(', ')),
          td(revoked ? 'Revoked' : 'Active'),
          td(revoked ? '' : revoke),
        ]),
      );
    }
  }

  async function loadAudit(): Promise<void> {
    const prefix = prefixInput.value.trim();
    const q = new URLSearchParams({ pageSize: '50' });
    if (prefix) q.set('actionPrefix', prefix);
    const res = await apiFetch<{ data: AuditRow[] }>(`/org/audit-log?${q.toString()}`);
    if (disposed) return;
    auditBody.replaceChildren();
    auditEmpty.hidden = res.data.length > 0;
    for (const r of res.data) {
      auditBody.appendChild(
        el('tr', {}, [
          td(new Date(r.createdAt).toLocaleString()),
          td(r.action),
          td(r.actorName ?? '—'),
          td(r.resourceType),
        ]),
      );
    }
  }

  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    void apiFetch<{ rawKey: string }>('/api-keys', { method: 'POST', body: JSON.stringify({ name }) }).then(async (key) => {
      nameInput.value = '';
      created.hidden = false;
      created.replaceChildren(
        el('span', {}, 'Copy your new key now — it will not be shown again: '),
        el('code', { 'data-role': 'api-key-raw', style: 'word-break: break-all;' }, key.rawKey),
      );
      await loadKeys();
      await loadAudit();
    });
  });
  auditForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void loadAudit();
  });

  void loadKeys().catch(() => setText(created, 'Failed to load API keys.'));
  void loadAudit().catch(() => undefined);

  return () => {
    disposed = true;
    teardownLayout();
  };
}
