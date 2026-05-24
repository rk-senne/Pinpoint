/**
 * Tiny History-API router for the vanilla-TS Dashboard (~50 LOC).
 *
 * Per Requirement 31.1 (UI without React): all pages are vanilla modules and
 * routing is the History API behind a single small module. Each route
 * registers a handler that mounts its DOM into the registered root element.
 *
 * Public API:
 * - `defineRoute(pattern, handler)` — register a handler for a path pattern
 *   with `:param` segments (e.g. `/projects/:id`).
 * - `start(rootEl)` — wire popstate + click interception on `<a data-route>`
 *   links and resolve the current URL.
 * - `navigate(path)` — `history.pushState` + re-run the matcher.
 *
 * Handlers receive the root element to render into and the parsed params.
 * Handlers may return a teardown function; the router invokes the teardown
 * before mounting the next route so each page can release signal
 * subscriptions, event listeners, and socket handlers.
 */

export type RouteHandler = (
  node: HTMLElement,
  params: Record<string, string>,
) => void | (() => void);

interface CompiledRoute {
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

const routes: CompiledRoute[] = [];
let rootEl: HTMLElement | null = null;
let activeTeardown: (() => void) | null = null;

export function defineRoute(pattern: string, handler: RouteHandler): void {
  const keys: string[] = [];
  const source = pattern.replace(/:([A-Za-z_]\w*)/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ regex: new RegExp(`^${source}/?$`), keys, handler });
}

export function navigate(path: string): void {
  history.pushState(null, '', path);
  resolve();
}

export function start(node: HTMLElement): void {
  rootEl = node;
  window.addEventListener('popstate', resolve);
  document.addEventListener('click', onLinkClick);
  resolve();
}

function onLinkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest('a[data-route]') as HTMLAnchorElement | null;
  if (!a || a.target === '_blank') return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
}

function resolve(): void {
  if (!rootEl) return;
  for (const r of routes) {
    const m = r.regex.exec(location.pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
    if (activeTeardown) {
      try {
        activeTeardown();
      } catch {
        /* swallow; continue mounting the next route */
      }
      activeTeardown = null;
    }
    rootEl.replaceChildren();
    const result = r.handler(rootEl, params);
    if (typeof result === 'function') {
      activeTeardown = result;
    }
    return;
  }
}

/** Test-only: clears registered routes, runs any active teardown, and detaches listeners. */
export function _resetRouterForTests(): void {
  if (activeTeardown) {
    try {
      activeTeardown();
    } catch {
      /* swallow */
    }
    activeTeardown = null;
  }
  routes.length = 0;
  rootEl = null;
  window.removeEventListener('popstate', resolve);
  document.removeEventListener('click', onLinkClick);
}
