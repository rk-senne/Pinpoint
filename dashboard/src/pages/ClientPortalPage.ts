/**
 * ClientPortalPage — manage client feedback portals.
 *
 * Fetches `GET /api/v1/portals` and renders portal cards. Provides a
 * "Create Portal" form that submits to `POST /api/v1/portals`.
 */

import type { Project } from '@pinpoint/shared';

import { mountAppLayout } from '../components/AppLayout';
import { apiFetch } from '../lib/api';
import { bindEvents, cloneTemplate, requireRole } from '../lib/render';
import { projectsStore } from '../lib/stores';

interface Portal {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  brandColor: string;
  logoUrl?: string;
  welcomeMessage?: string;
  active: boolean;
}

export function mountClientPortalPage(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  const fragment = cloneTemplate('tpl-client-portal-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  if (!contentRoot) {
    throw new Error('mountClientPortalPage: template is empty');
  }

  const listEl = requireRole(contentRoot, 'portal-list');
  const formEl = requireRole(contentRoot, 'portal-form') as HTMLElement;
  const errorEl = requireRole(contentRoot, 'error');

  const cleanupEvents = bindEvents(contentRoot, {
    showCreate: () => {
      formEl.hidden = !formEl.hidden;
    },
    submitPortal: async (e) => {
      e.preventDefault();
      const form = contentRoot.querySelector<HTMLFormElement>('[data-role="create-form"]')!;
      const data = new FormData(form);
      const body = {
        projectId: data.get('projectId') as string,
        title: data.get('title') as string,
        slug: data.get('slug') as string,
        welcomeMessage: data.get('welcomeMessage') as string,
        brandColor: data.get('brandColor') as string,
        logoUrl: data.get('logoUrl') as string,
      };
      if (!body.title || !body.slug || !body.projectId) {
        errorEl.textContent = 'Title, slug, and project are required.';
        errorEl.hidden = false;
        return;
      }
      try {
        errorEl.hidden = true;
        await apiFetch('/portals', { method: 'POST', body: JSON.stringify(body) });
        form.reset();
        formEl.hidden = true;
        void loadPortals();
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Failed to create portal.';
        errorEl.hidden = false;
      }
    },
  });

  async function loadPortals(): Promise<void> {
    try {
      const portals = await apiFetch<Portal[]>('/portals');
      renderPortals(portals);
    } catch {
      listEl.innerHTML = '<p style="color:#888;font-size:13px;">Failed to load portals.</p>';
    }
  }

  function renderPortals(portals: Portal[]): void {
    listEl.replaceChildren();
    if (portals.length === 0) {
      listEl.innerHTML = '<p style="color:#888;font-size:13px;">No portals yet.</p>';
      return;
    }
    for (const portal of portals) {
      const card = document.createElement('div');
      card.style.cssText =
        'border:1px solid #e5e7eb;border-radius:8px;padding:14px;display:flex;align-items:center;gap:12px;';
      card.innerHTML = `
        <div style="width:12px;height:12px;border-radius:50%;background:${portal.brandColor || '#4f46e5'};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(portal.title)}</div>
          <div style="font-size:12px;color:#888;">/${escapeHtml(portal.slug)}</div>
        </div>
        <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${portal.active ? '#dcfce7' : '#f3f4f6'};color:${portal.active ? '#166534' : '#6b7280'};">${portal.active ? 'Active' : 'Inactive'}</span>
      `;
      listEl.appendChild(card);
    }
  }

  // Populate project select options
  function populateProjectSelect(): void {
    const select = contentRoot.querySelector<HTMLSelectElement>('[data-role="project-select"]');
    if (!select) return;
    const projects = projectsStore.list.get();
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a project';
    select.appendChild(placeholder);
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    }
  }

  populateProjectSelect();
  void loadPortals();

  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  return () => {
    cleanupEvents();
    teardownLayout();
    contentRoot.remove();
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
