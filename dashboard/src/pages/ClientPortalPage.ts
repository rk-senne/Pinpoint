/**
 * ClientPortalPage — manage client feedback portals.
 *
 *   list  → GET    /api/v1/portals
 *   create→ POST   /api/v1/portals
 *   edit  → PATCH  /api/v1/portals/:id   (title, welcome message, colour, logo, active)
 *   delete→ DELETE /api/v1/portals/:id
 *
 * The API returns raw snake_case rows (`brand_color`, `project_id`, …); they are
 * normalised in `lib/automationFormat.ts`. All text is rendered via `el`.
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './ClientPortalPage.templates.html?raw';
import { mountAppLayout } from '../components/AppLayout';
import { createEmptyState } from '../components/EmptyState';
import { showToast } from '../components/Toast';
import { ApiError, apiFetch } from '../lib/api';
import {
  buildPortalBody,
  DEFAULT_BRAND_COLOR,
  normalizePortal,
  slugify,
  type Portal,
  type PortalFormInput,
} from '../lib/automationFormat';
import { bindEvents, cloneTemplate, requireRole } from '../lib/render';
import { projectsStore } from '../lib/stores';
import { el, setText } from '@pinpoint/shared';

const FIELD_ERRORS = ['projectId', 'title', 'slug', 'logoUrl'] as const;

export function mountClientPortalPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  registerTemplates('ClientPortalPage', templatesHtml);
  const fragment = cloneTemplate('tpl-client-portal-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  if (!contentRoot) throw new Error('mountClientPortalPage: template is empty');

  const listEl = requireRole(contentRoot, 'portal-list');
  const formWrap = requireRole(contentRoot, 'portal-form');
  const formEl = requireRole(contentRoot, 'create-form') as HTMLFormElement;
  const errorEl = requireRole(contentRoot, 'error');
  const createBtn = requireRole(contentRoot, 'create-btn') as HTMLButtonElement;
  const formTitle = requireRole(contentRoot, 'form-title');
  const formSubmit = requireRole(contentRoot, 'form-submit') as HTMLButtonElement;
  const projectField = requireRole(contentRoot, 'project-field');
  const select = requireRole(contentRoot, 'project-select') as HTMLSelectElement;
  const slugHint = requireRole(contentRoot, 'slug-hint');
  const field = (name: string): HTMLInputElement => formEl.elements.namedItem(name) as HTMLInputElement;

  let portals: Portal[] = [];
  let state: 'loading' | 'ready' | 'error' = 'loading';
  let editing: Portal | null = null;
  let confirmingId: string | null = null;
  let slugTouched = false;
  let busy = false;
  let disposed = false;

  const SLUG_HINT = slugHint.textContent ?? '';

  // --- form helpers --------------------------------------------------------
  function clearErrors(): void {
    errorEl.hidden = true;
    errorEl.textContent = '';
    for (const name of FIELD_ERRORS) {
      const node = requireRole(contentRoot, `err-${name}`);
      node.hidden = true;
      node.textContent = '';
    }
  }

  function showFieldErrors(errors: Partial<Record<(typeof FIELD_ERRORS)[number], string>>): void {
    for (const name of FIELD_ERRORS) {
      const msg = errors[name];
      if (!msg) continue;
      const node = requireRole(contentRoot, `err-${name}`);
      setText(node, msg);
      node.hidden = false;
    }
    const first = FIELD_ERRORS.find((n) => errors[n]);
    if (first) (first === 'projectId' ? select : field(first)).focus();
  }

  function openForm(portal: Portal | null): void {
    editing = portal;
    clearErrors();
    formEl.reset();
    slugTouched = portal !== null;
    const isEdit = portal !== null;
    setText(formTitle, isEdit ? `Edit “${portal.title}”` : 'New portal');
    setText(formSubmit, isEdit ? 'Save changes' : 'Create');
    projectField.hidden = isEdit;
    field('slug').disabled = isEdit;
    setText(slugHint, isEdit ? 'The slug is part of the portal’s address and can’t be changed.' : SLUG_HINT);
    if (portal) {
      field('title').value = portal.title;
      field('slug').value = portal.slug;
      field('welcomeMessage').value = portal.welcomeMessage ?? '';
      field('brandColor').value = portal.brandColor;
      field('logoUrl').value = portal.logoUrl ?? '';
    } else {
      field('brandColor').value = DEFAULT_BRAND_COLOR;
    }
    formWrap.hidden = false;
    createBtn.setAttribute('aria-expanded', 'true');
    field('title').focus();
    formWrap.scrollIntoView?.({ block: 'nearest' });
  }

  function closeForm(): void {
    editing = null;
    formWrap.hidden = true;
    createBtn.setAttribute('aria-expanded', 'false');
    clearErrors();
  }

  function readForm(): PortalFormInput {
    return {
      projectId: select.value,
      title: field('title').value,
      slug: field('slug').value,
      welcomeMessage: field('welcomeMessage').value,
      brandColor: field('brandColor').value,
      logoUrl: field('logoUrl').value,
    };
  }

  // Auto-suggest the slug from the title until the user edits the slug.
  const onTitleInput = (): void => {
    if (!slugTouched && !editing) field('slug').value = slugify(field('title').value);
  };
  const onSlugInput = (): void => { slugTouched = true; };
  field('title').addEventListener('input', onTitleInput);
  field('slug').addEventListener('input', onSlugInput);

  // --- submit --------------------------------------------------------------
  async function submitPortal(): Promise<void> {
    if (busy) return;
    clearErrors();
    const result = buildPortalBody(readForm(), { requireProject: editing === null });
    if (!result.ok) {
      showFieldErrors(result.errors);
      return;
    }
    busy = true;
    formSubmit.disabled = true;
    try {
      if (editing) {
        const { slug: _slug, projectId: _p, ...patch } = result.body;
        void _slug; void _p;
        await apiFetch(`/portals/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: patch.title,
            welcomeMessage: patch.welcomeMessage ?? '',
            brandColor: patch.brandColor,
            logoUrl: patch.logoUrl ?? null,
          }),
        });
        showToast({ message: 'Portal updated', variant: 'success' });
      } else {
        await apiFetch('/portals', { method: 'POST', body: JSON.stringify(result.body) });
        showToast({ message: 'Client portal created', variant: 'success' });
      }
      closeForm();
      await loadPortals();
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the portal.';
      // A taken slug comes back from the API as a 500/409 on the unique index.
      errorEl.textContent =
        err instanceof ApiError && !editing && (err.status === 409 || err.status >= 500)
          ? 'That slug may already be taken — try a different one. (' + message + ')'
          : message;
      errorEl.hidden = false;
    } finally {
      busy = false;
      formSubmit.disabled = false;
    }
  }

  // --- list ----------------------------------------------------------------
  async function loadPortals(): Promise<void> {
    try {
      const { data } = await apiFetch<{ data: Array<Record<string, unknown>> }>('/portals?page=1&pageSize=100');
      if (disposed) return;
      portals = data.map(normalizePortal);
      state = 'ready';
    } catch {
      if (disposed) return;
      state = 'error';
    }
    renderPortals();
  }

  function projectName(id: string): string {
    return projectsStore.list.get().find((p) => p.id === id)?.name ?? 'Project removed';
  }

  function renderPortals(): void {
    listEl.replaceChildren();
    if (state === 'loading') return;
    if (state === 'error') {
      const retry = el('button', { type: 'button', class: 'pp-btn pp-btn--secondary' }, 'Retry');
      retry.addEventListener('click', () => void loadPortals());
      listEl.appendChild(el('div', { class: 'pp-load-error', role: 'alert' }, [el('span', {}, 'Couldn’t load portals.'), retry]));
      return;
    }
    if (portals.length === 0) {
      listEl.appendChild(createEmptyState('no-portals', { onCta: () => openForm(null) }));
      return;
    }
    const ul = el('ul', { class: 'pp-rows' });
    for (const portal of portals) ul.appendChild(renderRow(portal));
    listEl.appendChild(ul);
  }

  function renderRow(portal: Portal): HTMLElement {
    const li = el('li', { class: 'pp-row', 'data-role': 'portal-row' });
    li.setAttribute('data-id', portal.id);

    // brandColor is validated to #rrggbb in normalizePortal; the CSSOM setter
    // would reject anything else anyway.
    const dot = el('span', { class: 'pp-dot', 'aria-hidden': 'true' });
    dot.style.background = portal.brandColor;

    const main = el('div', { class: 'pp-row__main' }, [
      el('div', { class: 'pp-row__title' }, portal.title),
      el('div', { class: 'pp-row__meta' }, `/${portal.slug} · ${projectName(portal.projectId)}`),
    ]);

    const actions = el('div', { class: 'pp-row__actions' });
    const toggle = el('button', {
      type: 'button',
      role: 'switch',
      class: 'pp-switch',
      'aria-label': `${portal.title}: ${portal.active ? 'active' : 'inactive'}`,
      'data-role': 'portal-toggle',
    });
    toggle.setAttribute('aria-checked', String(portal.active));
    toggle.appendChild(el('span', { class: 'pp-switch__thumb', 'aria-hidden': 'true' }));
    toggle.addEventListener('click', () => void setActive(portal, !portal.active));
    actions.append(
      toggle,
      el('span', { class: `pp-badge ${portal.active ? 'pp-badge--positive' : 'pp-badge--neutral'}` }, portal.active ? 'Active' : 'Inactive'),
    );
    const edit = el('button', { type: 'button', class: 'pp-btn pp-btn--ghost pp-btn--sm', 'aria-label': `Edit ${portal.title}`, 'data-role': 'portal-edit' }, 'Edit');
    edit.addEventListener('click', () => openForm(portal));
    actions.appendChild(edit);

    if (confirmingId === portal.id) {
      const yes = el('button', { type: 'button', class: 'pp-btn pp-btn--danger pp-btn--sm', 'data-role': 'portal-delete-confirm' }, 'Confirm delete');
      const no = el('button', { type: 'button', class: 'pp-btn pp-btn--secondary pp-btn--sm' }, 'Cancel');
      yes.addEventListener('click', () => void deletePortal(portal));
      no.addEventListener('click', () => { confirmingId = null; renderPortals(); });
      actions.append(yes, no);
      queueMicrotask(() => yes.focus());
    } else {
      const del = el('button', { type: 'button', class: 'pp-btn pp-btn--ghost-danger pp-btn--sm', 'aria-label': `Delete ${portal.title}`, 'data-role': 'portal-delete' }, 'Delete');
      del.addEventListener('click', () => { confirmingId = portal.id; renderPortals(); });
      actions.appendChild(del);
    }

    li.append(dot, main, actions);
    return li;
  }

  async function setActive(portal: Portal, active: boolean): Promise<void> {
    try {
      await apiFetch(`/portals/${encodeURIComponent(portal.id)}`, { method: 'PATCH', body: JSON.stringify({ active }) });
    } catch {
      return; // toast already shown
    }
    portal.active = active;
    renderPortals();
  }

  async function deletePortal(portal: Portal): Promise<void> {
    try {
      await apiFetch(`/portals/${encodeURIComponent(portal.id)}`, { method: 'DELETE' });
    } catch {
      return;
    }
    confirmingId = null;
    portals = portals.filter((p) => p.id !== portal.id);
    if (editing?.id === portal.id) closeForm();
    showToast({ message: 'Portal deleted', variant: 'success' });
    renderPortals();
  }

  // --- projects select (the sidebar loads projects asynchronously) -----------
  function populateProjectSelect(): void {
    const current = select.value;
    select.replaceChildren(el('option', { value: '' }, 'Select a project'));
    for (const p of projectsStore.list.get().filter((x) => x.status === 'active')) {
      select.appendChild(el('option', { value: p.id }, p.name));
    }
    select.value = current;
  }
  populateProjectSelect();
  const unsubProjects = projectsStore.list.subscribe(() => {
    populateProjectSelect();
    if (state === 'ready') renderPortals(); // refresh project names
  });

  const cleanupEvents = bindEvents(contentRoot, {
    showCreate: () => (formWrap.hidden || editing ? openForm(null) : closeForm()),
    cancelForm: () => closeForm(),
    submitPortal: (e) => { e.preventDefault(); void submitPortal(); },
  });

  void loadPortals();
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  return () => {
    disposed = true;
    unsubProjects();
    field('title').removeEventListener('input', onTitleInput);
    field('slug').removeEventListener('input', onSlugInput);
    cleanupEvents();
    teardownLayout();
    contentRoot.remove();
  };
}
