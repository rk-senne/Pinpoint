import { getCsrfToken } from './auth';
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
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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
    showToast({ message, variant: 'error' });
    throw new ApiError(message, code, res.status, details);
  }

  return res.json() as Promise<T>;
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
