/**
 * ReviewLinkPage — vanilla-TS page for the proxy review-link flow (Mission
 * C1). Registered via `defineRoute('/review/:linkId', mountReviewLinkPage)`.
 *
 * It frames the SERVER-SIDE proxy at `GET /review/:linkId/frame` inside a sandboxed
 * iframe, alongside a sidebar that explains the flow and surfaces an honest
 * notice about the proxy's limitations.
 *
 * HONEST LIMITATIONS (shown to the reviewer in the sidebar and documented in
 * the README + `proxy.routes.ts`):
 *   - Sites sending `X-Frame-Options: DENY|SAMEORIGIN` or a CSP
 *     `frame-ancestors` directive will refuse to render inside the iframe —
 *     that is the reviewed site's choice and the proxy cannot (and must not)
 *     strip those directives from the real origin.
 *   - Sites that render entirely via client-side JS against an authenticated
 *     session show only their logged-out shell, because the proxy fetches the
 *     raw document anonymously.
 *   - Subresources (CSS/JS/images) are loaded by the reviewer's own browser
 *     from the real origin via the injected `<base>`, so assets that require
 *     the origin's cookies/auth may not load.
 *
 * SECURITY: the iframe is sandboxed WITHOUT `allow-same-origin`
 * (`allow-forms allow-scripts allow-popups`), so the reviewed third-party
 * page runs in an opaque origin and cannot read dashboard cookies/CSRF or call
 * the API as the viewer; the server also sends a CSP `sandbox` on the frame.
 * Because the frame cannot call the API, the injected overlay `postMessage`s
 * the feedback here; this page verifies the sender (`event.source` is our
 * iframe, `event.origin === 'null'`), validates shape/size, and POSTs to the
 * guest endpoint using ITS OWN linkId. All dynamic text is written via
 * `textContent` (never `innerHTML`).
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './ReviewLinkPage.templates.html?raw';
import { cloneTemplate, mount, requireSlot, text } from '../lib/render';
import { apiFetch } from '../lib/api';

/** postMessage protocol shared with server/.../reviewOverlay.ts. */
export const REVIEW_FEEDBACK_MSG = 'pinpoint:review-feedback';
export const REVIEW_FEEDBACK_RESULT_MSG = 'pinpoint:review-feedback-result';
/** Hard cap on the serialized size of a frame-supplied payload. */
export const MAX_FEEDBACK_MESSAGE_BYTES = 12_000;

const SEVERITIES = ['critical', 'major', 'minor', 'informational'] as const;
type Severity = (typeof SEVERITIES)[number];

export interface GuestFeedbackPayload {
  name: string;
  description: string;
  severity?: Severity;
  pageUrl: string;
}

/**
 * Validate an untrusted message payload from the frame. Returns a fresh,
 * rebuilt object (unknown keys dropped) or null. Mirrors the server's
 * GuestFeedbackBodySchema limits.
 */
export function parseFeedbackMessage(
  data: unknown,
): { id: string; payload: GuestFeedbackPayload } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== REVIEW_FEEDBACK_MSG) return null;
  let size: number;
  try {
    size = JSON.stringify(data).length;
  } catch {
    return null;
  }
  if (size > MAX_FEEDBACK_MESSAGE_BYTES) return null;
  const id = d.id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) return null;
  const p = d.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return null;
  const { name, description, severity, pageUrl } = p;
  if (typeof name !== 'string' || name.length < 1 || name.length > 100) return null;
  if (typeof description !== 'string' || description.length < 1 || description.length > 5000) return null;
  if (severity !== undefined && !SEVERITIES.includes(severity as Severity)) return null;
  if (typeof pageUrl !== 'string' || pageUrl.length > 2000) return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return {
    id,
    payload: {
      name,
      description,
      ...(severity !== undefined ? { severity: severity as Severity } : {}),
      pageUrl,
    },
  };
}

/**
 * The proxied document is served by the API at `/review/:linkId/frame`.
 * This page itself owns `/review/:linkId`, so framing that same path would
 * recursively frame the dashboard instead of the reviewed site.
 */
function proxyUrl(linkId: string): string {
  return `/review/${encodeURIComponent(linkId)}/frame`;
}

const LIMITATIONS_NOTICE = [
  'Heads up: this is a live, server-side preview of the page.',
  'Sites that block framing (X-Frame-Options / CSP frame-ancestors) or that',
  'render only after login may not display here. Page assets load directly',
  'from the original site in your browser.',
].join(' ');

/**
 * Mount the review-link page inside `node`. Returns a teardown that removes
 * the mounted DOM. Designed for `defineRoute('/review/:linkId', …)`.
 *
 * The proxy lives at the app root (`/review/:linkId/frame`), outside the
 * `/api/v1` surface, so the iframe `src` is a root-relative path.
 */
export function mountReviewLinkPage(
  node: HTMLElement,
  params: Record<string, string>,
): () => void {
  registerTemplates('ReviewLinkPage', templatesHtml);
  const linkId = params.linkId ?? '';

  mount(node, cloneTemplate('tpl-review-link-page'));
  const root = node.querySelector<HTMLElement>('[data-fl-review-root]')!;
  const frame = requireSlot(root, 'frame') as HTMLIFrameElement;
  const statusEl = requireSlot(root, 'status');
  const noticeEl = requireSlot(root, 'notice');

  // Sidebar notice (honest limitations). Written as text, never innerHTML.
  text(noticeEl, LIMITATIONS_NOTICE);
  noticeEl.removeAttribute('hidden');

  if (!linkId) {
    text(statusEl, 'Missing review link id.');
    return () => {
      if (root.parentNode) root.remove();
    };
  }

  text(statusEl, 'Loading preview…');
  // Point the iframe at the server-side proxy. The proxy enforces the
  // shared-link rules, SSRF egress guard, and injects the feedback overlay.
  frame.src = proxyUrl(linkId);

  const onLoad = (): void => {
    text(statusEl, 'Preview loaded. Use “Send feedback” inside the frame.');
  };
  const onError = (): void => {
    text(statusEl, 'This page could not be previewed. It may block framing or require login.');
  };
  frame.addEventListener('load', onLoad);
  frame.addEventListener('error', onError);

  // Feedback relay from the opaque-origin frame (see header SECURITY note).
  let inFlight = false;
  const reply = (id: string, ok: boolean): void => {
    frame.contentWindow?.postMessage({ type: REVIEW_FEEDBACK_RESULT_MSG, id, ok }, '*');
  };
  const onMessage = (event: MessageEvent): void => {
    // Only OUR iframe, and only from its opaque ('null') origin.
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    if (event.origin !== 'null') return;
    const msg = parseFeedbackMessage(event.data);
    if (!msg || inFlight) return;
    inFlight = true;
    apiFetch(`/shared/${encodeURIComponent(linkId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify(msg.payload),
    })
      .then(() => reply(msg.id, true))
      .catch(() => reply(msg.id, false))
      .finally(() => {
        inFlight = false;
      });
  };
  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    frame.removeEventListener('load', onLoad);
    frame.removeEventListener('error', onError);
    if (root.parentNode) root.remove();
  };
}
