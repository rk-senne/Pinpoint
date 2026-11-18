/**
 * Helpers shared by the real-UI browser specs (`e2e/browser/*.spec.ts`).
 *
 * The browser specs drive the live Dashboard (Vite dev on `FL_APP_URL`, which
 * proxies `/api` to the API). To stay self-contained and idempotent, each
 * spec provisions its own fixtures (projects, annotations, widget keys,
 * shared links) straight through the REST API and then asserts the UI renders
 * them.
 *
 * Fixtures are created with the seed account's BEARER token
 * (`Authorization: Bearer <jwt>`), which the server treats as CSRF-exempt
 * (proof-of-possession, Req 18.5). The token + the account id are read from
 * `.auth/seed-session.json`, written once per run by `global-setup.ts`. This
 * avoids any cookie-domain juggling (the seed cookies are pinned to
 * `127.0.0.1`, the Dashboard is on `localhost`) — the API fixture calls go
 * directly to `FL_API_URL` with the bearer header.
 *
 * Nothing here logs in via the API more than the one login `global-setup.ts`
 * already performed, so the 5-logins/min auth rate limit is never tripped by
 * fixture setup.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type APIRequestContext, type Browser, request as requestFactory } from '@playwright/test';

export const API_URL = process.env.FL_API_URL ?? 'http://localhost:3001';
export const APP_URL = process.env.FL_APP_URL ?? 'http://localhost:4173';
export const SEED_EMAIL = process.env.FL_E2E_EMAIL ?? '';
export const SEED_PASSWORD = process.env.FL_E2E_PASSWORD ?? '';

const SEED_SESSION_FILE = resolve(process.cwd(), '.auth/seed-session.json');

export interface SeedSession {
  email: string;
  body: {
    user: { id: string; email: string; name: string };
    token: string;
    csrfToken: string;
  };
}

/** Read the seed session (bearer token + user) written by global-setup.ts. */
export function readSeedSession(): SeedSession | null {
  try {
    const parsed = JSON.parse(readFileSync(SEED_SESSION_FILE, 'utf8')) as SeedSession | null;
    if (!parsed || !parsed.body?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * An API client bound to the seed account's bearer token. Created from a
 * fresh request context so it carries no cookies — the bearer alone
 * authenticates and is CSRF-exempt.
 */
export interface ApiClient {
  ctx: APIRequestContext;
  userId: string;
  dispose(): Promise<void>;
}

export async function makeApiClient(): Promise<ApiClient | null> {
  const seed = readSeedSession();
  if (!seed) return null;
  const ctx = await requestFactory.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${seed.body.token}`,
      'Content-Type': 'application/json',
    },
  });
  return {
    ctx,
    userId: seed.body.user.id,
    dispose: () => ctx.dispose(),
  };
}

export interface CreatedProject {
  id: string;
  name: string;
  pages: Array<{ id: string; url: string }>;
}

/** Create a project via the API. Returns the project + its pages. */
export async function createProject(
  api: ApiClient,
  attrs: { name: string; urls: string[] },
): Promise<CreatedProject> {
  const res = await api.ctx.post('/api/v1/projects', { data: attrs });
  if (res.status() !== 201) {
    throw new Error(`createProject failed ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    project: { id: string; name: string };
    pages: Array<{ id: string; url: string }>;
  };
  return { id: body.project.id, name: body.project.name, pages: body.pages };
}

/** Delete a project (requires confirmationToken = project name per Req 2.7). */
export async function deleteProject(api: ApiClient, project: CreatedProject): Promise<void> {
  await api.ctx.delete(`/api/v1/projects/${project.id}`, {
    data: { confirmationToken: project.name },
  });
}

export interface CreatedAnnotation {
  id: string;
  pinNumber: number;
}

/** Create an authored (non-guest) annotation via the API. */
export async function createAnnotation(
  api: ApiClient,
  projectId: string,
  pageUrl: string,
  overrides: Partial<{
    body: string;
    type: 'note' | 'suggestion' | 'guideline';
    severity: 'critical' | 'major' | 'minor' | 'informational';
    consoleLogs: unknown[];
    jsErrors: unknown[];
  }> = {},
): Promise<CreatedAnnotation> {
  const data: Record<string, unknown> = {
    pageUrl,
    body: overrides.body ?? 'Browser-spec annotation',
    type: overrides.type ?? 'note',
    severity: overrides.severity ?? 'major',
    target: {
      cssSelector: 'body',
      xpath: '/html/body',
      pageX: 10,
      pageY: 20,
      tagName: 'BODY',
      textSnippet: '',
    },
    environment: {
      browserFamily: 'Chrome',
      browserVersion: '120.0',
      osFamily: 'macOS',
      osVersion: '14.0',
      deviceType: 'desktop',
      userAgentRaw:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  };
  if (overrides.consoleLogs) data.consoleLogs = overrides.consoleLogs;
  if (overrides.jsErrors) data.jsErrors = overrides.jsErrors;

  const res = await api.ctx.post(`/api/v1/projects/${projectId}/annotations`, { data });
  if (res.status() !== 201) {
    throw new Error(`createAnnotation failed ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { annotation: { id: string; pinNumber: number } };
  return { id: body.annotation.id, pinNumber: body.annotation.pinNumber };
}

/** List a project's annotations. Reads the `{ data }` envelope. */
export async function listAnnotations(
  api: ApiClient,
  projectId: string,
): Promise<Array<{ id: string; isGuest?: boolean; pinNumber: number }>> {
  const res = await api.ctx.get(`/api/v1/projects/${projectId}/annotations`);
  if (!res.ok()) throw new Error(`listAnnotations failed ${res.status()}`);
  const body = (await res.json()) as { data: Array<{ id: string; isGuest?: boolean; pinNumber: number }> };
  return body.data;
}

export interface WidgetKey {
  id: string;
  rawKey: string;
}

/** Issue a project-bound widget key with an optional origin allow-list. */
export async function createWidgetKey(
  api: ApiClient,
  projectId: string,
  allowedOrigins: string[] = [],
): Promise<WidgetKey> {
  const res = await api.ctx.post('/api/v1/api-keys', {
    data: {
      name: `browser-widget-${Date.now()}`,
      keyType: 'widget',
      projectId,
      allowedOrigins,
    },
  });
  if (res.status() !== 201) {
    throw new Error(`createWidgetKey failed ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; rawKey: string };
  return { id: body.id, rawKey: body.rawKey };
}

export interface SharedLink {
  id: string;
  allowFeedback: boolean;
}

/**
 * Create (or update) a shared link for a project. `allowFeedback: true` is
 * required for the guest feedback endpoint to accept submissions.
 */
export async function createSharedLink(
  api: ApiClient,
  projectId: string,
  opts: { allowFeedback?: boolean } = {},
): Promise<SharedLink> {
  const res = await api.ctx.post(`/api/v1/projects/${projectId}/share`, {
    data: { allowFeedback: opts.allowFeedback ?? true },
  });
  if (![200, 201].includes(res.status())) {
    throw new Error(`createSharedLink failed ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { sharedLink: { id: string; allowFeedback?: boolean } };
  return { id: body.sharedLink.id, allowFeedback: body.sharedLink.allowFeedback ?? true };
}

/**
 * Submit a guest feedback item against a shared link (public endpoint —
 * no auth). Produces a guest-authored annotation (`isGuest=true`) which the
 * dashboard flags with an "Unverified guest" badge.
 */
export async function submitGuestFeedback(
  sharedLinkId: string,
  pageUrl: string,
  opts: { name?: string; description?: string } = {},
): Promise<number> {
  const ctx = await requestFactory.newContext({ baseURL: API_URL });
  try {
    const res = await ctx.post(`/api/v1/shared/${sharedLinkId}/feedback`, {
      data: {
        name: opts.name ?? 'Guest Reviewer',
        description: opts.description ?? 'Guest submission from browser spec',
        pageUrl,
        severity: 'minor',
      },
    });
    return res.status();
  } finally {
    await ctx.dispose();
  }
}

/** Reusable unique suffix so re-runs never collide. */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
