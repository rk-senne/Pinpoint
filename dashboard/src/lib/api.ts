import { clearAuth, getCsrfToken } from './auth';
import { navigate } from './router';
import { showToast } from '../components/Toast';
import type { User } from '@pinpoint/shared';

/**
 * Single source of truth for the Dashboard's API URL prefix.
 * All current endpoints live under `/api/v1` (Requirement 25.3, design decision 10).
 */
export const API_BASE = '/api/v1';

/**
 * Custom error class thrown by `apiFetch` on non-2xx responses.
 * Exposes the structured `code` and optional `details` from the API's
 * standard error envelope `{ error: { code, message, details? } }` so
 * callers can branch on specific error codes (e.g. `EMAIL_NOT_VERIFIED`).
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly details?: unknown;
  public readonly status: number;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    // Fix prototype chain for instanceof checks in transpiled ES5 output.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * The set of HTTP methods that mutate state on the server. The CSRF
 * middleware enforces `X-CSRF-Token == fl_csrf` cookie on exactly these
 * methods (Req 18.4, 18.5). Read-only requests (`GET`, `HEAD`, `OPTIONS`)
 * do not require the header.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes that are meant to be viewed without a dashboard session. */
const PUBLIC_PATH = /^\/(auth|login|shared|review|portal|verify-email|reset-password|invitations|onboarding)(\/|$)/;

/**
 * A 401 from an authenticated endpoint means the session is gone (expired,
 * revoked by a password/email change, logged out elsewhere). Drop the
 * in-memory auth state and send the user to the login form instead of leaving
 * a half-rendered, empty shell. Credential-check endpoints (`/auth/...`)
 * legitimately answer 401 and are left to their callers.
 */
function handleSessionLost(apiPath: string, status: number): boolean {
  if (status !== 401 || apiPath.startsWith('/auth/')) return false;
  if (PUBLIC_PATH.test(window.location.pathname)) return false;
  clearAuth();
  navigate('/auth');
  return true;
}

/**
 * Issue a JSON request to the API server.
 *
 * Requirements 18.1, 18.2, 18.4: every fetch is sent with
 * `credentials: 'include'` so the browser attaches the HttpOnly
 * `fl_session` cookie issued at login. State-changing requests
 * additionally carry the `X-CSRF-Token` header echoing the
 * module-level CSRF token captured from the login response (the
 * double-submit-cookie pattern that the server's `csrfMiddleware`
 * verifies — see `server/src/middleware/csrf.ts`).
 *
 * Read-only requests skip the CSRF header because the server's
 * middleware does not enforce it on `GET`/`HEAD`/`OPTIONS`. We still
 * send credentials on every call so the session cookie travels with
 * the request and the API server identifies the user.
 */
/**
 * API paths are relative to API_BASE. Refuse anything that could leave the
 * API origin (absolute/protocol-relative URLs, backslashes, `..` segments),
 * so a value that reaches `path` from the URL or the server can never turn a
 * credentialed request into a cross-origin one.
 */
export function assertApiPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /(^|\/)\.\.(\/|$|\?)/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(`Refusing non-API path: ${String(path).slice(0, 80)}`);
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  assertApiPath(path);
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (MUTATING_METHODS.has(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body?.error?.message || `Request failed with status ${res.status}`;
    const code: string = body?.error?.code || 'UNKNOWN_ERROR';
    const details: unknown = body?.error?.details;
    if (handleSessionLost(path, res.status)) {
      throw new ApiError(message, code, res.status, details);
    }
    showToast({ message, variant: 'error' });
    throw new ApiError(message, code, res.status, details);
  }

  // 204 No Content (DELETE on most routes) has no body to parse.
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

/**
 * Issue a request whose successful response is a FILE (e.g. the CSV/PDF
 * export), not JSON. Mirrors `apiFetch` (credentials, CSRF header, error
 * envelope → `ApiError` + toast) but returns the body as a Blob together
 * with the server-suggested filename from `Content-Disposition`.
 */
export async function apiFetchBlob(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; filename: string | null }> {
  assertApiPath(path);
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (MUTATING_METHODS.has(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message || `Request failed with status ${res.status}`;
    if (handleSessionLost(path, res.status)) {
      throw new ApiError(message, body?.error?.code || 'UNKNOWN_ERROR', res.status, body?.error?.details);
    }
    showToast({ message, variant: 'error' });
    throw new ApiError(message, body?.error?.code || 'UNKNOWN_ERROR', res.status, body?.error?.details);
  }
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return { blob: await res.blob(), filename: match ? match[1]! : null };
}

/**
 * Fetch the current user from `GET /api/v1/users/me`. Normalizes the
 * server response shape: the route returns `{ user: User }` but historic
 * builds returned the bare `User`; this helper accepts either.
 *
 * Accepts an optional `apiFetch` shim so callers that already inject a
 * fake fetch (tests, or pages with their own dependency seam) can reuse
 * the normalisation without duplicating the response handling.
 */
export async function fetchCurrentUser(
  fetcher: typeof apiFetch = apiFetch,
): Promise<User> {
  const response = await fetcher<User | { user: User }>('/users/me');
  return (response as { user?: User }).user ?? (response as User);
}

/* -------------------------------------------------------------------------- */
/* Annotation suggestions (AI triage + smart suggestions)                     */
/* -------------------------------------------------------------------------- */

/** AI triage block from `GET /annotations/:id/suggestions`. */
export interface AnnotationTriage {
  suggestedSeverity: 'critical' | 'major' | 'minor' | 'informational';
  suggestedTags: string[];
  duplicates: Array<{ id: string; body: string; pinNumber: number; similarity: number }>;
  suggestedAssignee: { userId: string; email: string; reason: string } | null;
}

/** A smart-suggestion row (past fix / component / assignee). */
export interface AnnotationSmartSuggestion {
  type: 'past_fix' | 'related_component' | 'assignee';
  title: string;
  detail: string;
  confidence: number;
}

/** Combined response of `GET /api/v1/annotations/:id/suggestions`. */
export interface AnnotationSuggestionsResponse {
  triage: AnnotationTriage;
  suggestions: AnnotationSmartSuggestion[];
}

/**
 * Fetch AI triage + smart suggestions for an existing annotation. Read-only.
 * Backed by `GET /api/v1/annotations/:id/suggestions`.
 */
export async function getAnnotationSuggestions(
  annotationId: string,
  fetcher: typeof apiFetch = apiFetch,
): Promise<AnnotationSuggestionsResponse> {
  return fetcher<AnnotationSuggestionsResponse>(
    `/annotations/${encodeURIComponent(annotationId)}/suggestions`,
  );
}
