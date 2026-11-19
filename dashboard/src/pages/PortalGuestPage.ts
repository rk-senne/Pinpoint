/**
 * PortalGuestPage — the guest-facing client portal, mounted at `/portal/:slug`.
 *
 * What the server gives us (see `server/.../clientPortal.routes.ts`):
 *   GET  /api/v1/portals/:slug/info      public: title, welcomeMessage, brandColor, logoUrl,
 *                                        allowNewFeedback, requireEmail (404 when missing/inactive)
 *   POST /api/v1/portals/:slug/access    public: emails a magic link (always 202, no oracle)
 *   GET  /api/v1/portals/:slug/feedback  `Authorization: Bearer <token>`: the project's feedback
 *                                        as an explicit DTO (401 for a missing/expired token)
 * The magic link emailed to the guest is `/portal/:slug?token=<24h token>`.
 * The API has NO guest submit endpoint for portals, so this page is read-only
 * (shared links / the widget remain the way to submit); the page says so.
 *
 * Security:
 *   - The token is removed from the address bar immediately (history.replaceState,
 *     so it is not kept in history / sent in Referer) and held in memory only.
 *   - Requests are credential-less (`credentials: 'omit'`): a guest page must never
 *     ride on a dashboard session.
 *   - Every server string is written with textContent; brand colour is accepted only
 *     if it is `#rrggbb`, the logo only if http(s).
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './PortalGuestPage.templates.html?raw';
import { el, setText, signal, STATUS_LABELS, type Signal } from '@pinpoint/shared';
import { API_BASE } from '../lib/api';
import { bindEvents, cloneTemplate, mount, requireSlot } from '../lib/render';
import { severityTextColor } from '../lib/severity';

type View = 'loading' | 'not_found' | 'access' | 'feedback';
const VIEWS: View[] = ['loading', 'not_found', 'access', 'feedback'];

interface PortalInfo {
  title: string;
  welcomeMessage: string | null;
  brandColor: string | null;
  logoUrl: string | null;
}

interface PortalFeedback {
  id: string;
  pinNumber: number | null;
  type: string;
  severity: string;
  status: string;
  body: string;
  createdAt: string | null;
  pageUrl: string | null;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Only `#rrggbb` ever reaches a style declaration. */
export function safeBrandColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : null;
}

/** Only http(s) URLs are used as an <img src>. */
export function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function toInfo(raw: Record<string, unknown>): PortalInfo {
  return {
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'Client portal',
    welcomeMessage: typeof raw.welcomeMessage === 'string' && raw.welcomeMessage ? raw.welcomeMessage : null,
    brandColor: safeBrandColor(raw.brandColor),
    logoUrl: safeLogoUrl(raw.logoUrl),
  };
}

function toFeedback(raw: Record<string, unknown>): PortalFeedback {
  return {
    id: String(raw.id ?? ''),
    pinNumber: typeof raw.pinNumber === 'number' ? raw.pinNumber : null,
    type: String(raw.type ?? ''),
    severity: String(raw.severity ?? ''),
    status: String(raw.status ?? ''),
    body: String(raw.body ?? ''),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    pageUrl: typeof raw.pageUrl === 'string' ? raw.pageUrl : null,
  };
}

/** Pull `?token=` out of the URL and scrub it from the address bar. */
function takeToken(): string {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';
  if (params.has('token')) {
    params.delete('token');
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }
  return token.trim();
}

export function mountPortalGuestPage(node: HTMLElement, params: Record<string, string> = {}): () => void {
  registerTemplates('PortalGuestPage', templatesHtml);
  const slug = params.slug ?? '';
  const enc = encodeURIComponent(slug);
  let token = takeToken();
  let disposed = false;

  mount(node, cloneTemplate('tpl-portal-guest'));
  const root = node.querySelector<HTMLElement>('[data-fl-portal-root]')!;
  const view: Signal<View> = signal<View>('loading');

  const titleEl = requireSlot(root, 'title');
  const logoEl = requireSlot(root, 'logo') as HTMLImageElement;
  const welcomeEl = requireSlot(root, 'welcome');
  const accessHint = requireSlot(root, 'access-hint');
  const accessTitle = requireSlot(root, 'access-title');
  const emailInput = requireSlot(root, 'email') as HTMLInputElement;
  const nameInput = requireSlot(root, 'name') as HTMLInputElement;
  const accessError = requireSlot(root, 'access-error');
  const accessSent = requireSlot(root, 'access-sent');
  const accessSubmit = requireSlot(root, 'access-submit') as HTMLButtonElement;
  const listEl = requireSlot(root, 'list');
  const emptyEl = requireSlot(root, 'empty');
  const countEl = requireSlot(root, 'count');

  const unsub = view.subscribe((current) => {
    for (const v of VIEWS) {
      const section = root.querySelector<HTMLElement>(`[data-section="${v}"]`);
      if (section) section.hidden = v !== current;
    }
  });

  function applyBranding(info: PortalInfo): void {
    setText(titleEl, info.title);
    document.title = info.title;
    if (info.brandColor) root.style.setProperty('--portal-brand', info.brandColor);
    if (info.logoUrl) {
      logoEl.src = info.logoUrl;
      logoEl.hidden = false;
    }
    if (info.welcomeMessage) {
      setText(welcomeEl, info.welcomeMessage);
      welcomeEl.hidden = false;
    }
  }

  function renderFeedback(items: PortalFeedback[]): void {
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;
    setText(countEl, items.length === 0 ? '' : `${items.length} item${items.length === 1 ? '' : 's'}`);
    for (const f of items) {
      const meta: string[] = [];
      if (f.type) meta.push(f.type);
      if (f.status) meta.push((STATUS_LABELS as Record<string, string>)[f.status] ?? f.status);
      if (f.createdAt && !Number.isNaN(Date.parse(f.createdAt))) meta.push(new Date(f.createdAt).toLocaleDateString());
      const sev = el('span', { class: 'pp-badge', 'data-role': 'portal-severity' }, f.severity || 'info');
      sev.style.color = severityTextColor(f.severity);
      const head = el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;' }, [
        el('strong', {}, f.pinNumber !== null ? `#${f.pinNumber}` : 'Feedback'),
        sev,
        el('span', { style: 'font-size:12px;color:var(--pp-text-secondary);' }, meta.join(' · ')),
      ]);
      const card = el(
        'li',
        { 'data-role': 'portal-feedback', style: 'background:var(--pp-bg-primary);border:1px solid var(--pp-border-light);border-radius:8px;padding:14px;' },
        [head, el('p', { style: 'margin:0;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;' }, f.body)],
      );
      if (f.pageUrl) {
        card.appendChild(el('p', { style: 'margin:8px 0 0;font-size:12px;color:var(--pp-text-tertiary);overflow-wrap:anywhere;' }, f.pageUrl));
      }
      listEl.appendChild(card);
    }
  }

  async function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json', ...headers }, credentials: 'omit' });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  function showAccess(expired: boolean): void {
    setText(accessTitle, expired ? 'Your link has expired' : 'Get your access link');
    setText(
      accessHint,
      expired
        ? 'Access links are valid for 24 hours. Enter your email to receive a new one.'
        : 'Enter your email and we will send you a link to view the feedback shared with you.',
    );
    view.set('access');
  }

  async function loadFeedback(): Promise<void> {
    try {
      const { status, body } = await getJson(`/portals/${enc}/feedback`, { Authorization: `Bearer ${token}` });
      if (disposed) return;
      if (status === 200 && Array.isArray(body?.feedback)) {
        renderFeedback((body.feedback as Array<Record<string, unknown>>).map(toFeedback));
        view.set('feedback');
        return;
      }
      if (status === 404) { view.set('not_found'); return; }
      token = '';
      showAccess(status === 401);
    } catch {
      if (!disposed) showAccess(false);
    }
  }

  async function init(): Promise<void> {
    try {
      const { status, body } = await getJson(`/portals/${enc}/info`);
      if (disposed) return;
      if (status !== 200 || !body?.portal) { view.set('not_found'); return; }
      applyBranding(toInfo(body.portal as Record<string, unknown>));
    } catch {
      if (!disposed) view.set('not_found');
      return;
    }
    if (token) await loadFeedback();
    else showAccess(false);
  }

  async function requestAccess(): Promise<void> {
    accessError.hidden = true;
    accessSent.hidden = true;
    const email = emailInput.value.trim();
    if (!email || !emailInput.checkValidity()) {
      setText(accessError, 'Enter a valid email address.');
      accessError.hidden = false;
      emailInput.focus();
      return;
    }
    accessSubmit.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/portals/${enc}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ email, ...(nameInput.value.trim() ? { name: nameInput.value.trim() } : {}) }),
      });
      if (res.status === 429) {
        setText(accessError, 'Too many requests. Please wait a few minutes and try again.');
        accessError.hidden = false;
      } else if (res.status === 202) {
        const body = await res.json().catch(() => null);
        setText(accessSent, typeof body?.message === 'string' ? body.message : "If that email is on the portal you'll receive a link.");
        accessSent.hidden = false;
      } else {
        setText(accessError, 'Could not send the link. Please try again.');
        accessError.hidden = false;
      }
    } catch {
      setText(accessError, 'Could not reach the server. Please try again.');
      accessError.hidden = false;
    } finally {
      accessSubmit.disabled = false;
    }
  }

  const cleanupEvents = bindEvents(root, {
    'request-access': (e: Event) => {
      e.preventDefault();
      void requestAccess();
    },
  });

  void init();

  return () => {
    disposed = true;
    token = '';
    unsub();
    cleanupEvents();
    document.title = 'Pinpoint';
    root.remove();
  };
}
