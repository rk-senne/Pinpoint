# ADR-004: Cookie + CSRF for Dashboard, Bearer JWT for Extension

## Status

Accepted

## Date

2025-05-24

## Context

Pinpoint has two client applications with fundamentally different security
contexts:

1. **Dashboard** — a first-party web app served from the same origin as the API
   (or a known CORS origin). Runs in a standard browser tab. Vulnerable to XSS
   and CSRF.
2. **Extension** — a Chrome Extension content script injected into arbitrary
   third-party pages. Cannot rely on same-origin cookies because the requests
   originate from the extension context, not the API origin. Not vulnerable to
   CSRF (no ambient credentials).

A single auth mechanism cannot serve both well:

- **Cookies alone** — work for the dashboard but not for the extension (cross-
  origin, different execution context).
- **Bearer tokens in localStorage** — work for the extension but expose the
  dashboard to XSS token theft (localStorage is readable by any script on the
  page).
- **Bearer tokens in memory** — safe from XSS persistence but lost on page
  refresh for the dashboard.

## Decision

Use a **dual auth strategy** from a single login endpoint:

### Dashboard: HttpOnly Cookie + Double-Submit CSRF

`POST /api/v1/auth/login` sets two cookies:

| Cookie       | Flags                              | Purpose                  |
|--------------|------------------------------------|--------------------------|
| `fl_session` | HttpOnly, Secure, SameSite=Lax     | Contains the JWT; not readable by JS |
| `fl_csrf`    | Readable, SameSite=Lax             | Double-submit CSRF token |

- The dashboard sends all requests with `credentials: 'include'`.
- Mutating verbs (`POST`, `PUT`, `PATCH`, `DELETE`) must include `X-CSRF-Token`
  header matching the `fl_csrf` cookie value.
- Server middleware (`server/src/middleware/csrf.ts`) rejects requests where
  `header !== cookie`.
- The dashboard **never** stores auth state in `localStorage`.

### Extension: Bearer JWT

The same login response body includes `{ token }`:

- The extension stores the token in `chrome.storage.local` under
  `pinpoint_auth_token`.
- Every API request includes `Authorization: Bearer <token>`.
- Bearer-authenticated requests are **CSRF-exempt** — the bearer itself is
  proof of possession (not ambient).
- The CSRF middleware skips validation when a valid Bearer token is present.

### Token lifecycle

- JWTs are short-lived (configurable, default 24h).
- Sliding-window refresh (`POST /api/v1/auth/refresh`) with a 7-day grace
  window post-expiry is planned for Phase 15.
- `POST /api/v1/auth/logout` clears both cookies (dashboard) and the extension
  removes the token from `chrome.storage.local`.

## Consequences

### Positive

- **XSS-resilient dashboard** — the JWT is in an HttpOnly cookie; even if an
  attacker achieves XSS, they cannot exfiltrate the session token.
- **CSRF-protected dashboard** — the double-submit pattern blocks cross-site
  request forgery.
- **Clean extension auth** — Bearer tokens work naturally from the extension
  context without cookie gymnastics.
- **Single endpoint** — one login call serves both clients; no separate auth
  flows to maintain.

### Negative

- **Two code paths in middleware** — the auth middleware must handle both cookie
  and bearer authentication, adding branching logic.
- **Token in chrome.storage** — if the user's Chrome profile is compromised,
  the token is accessible. Mitigated by short expiry and future refresh-token
  rotation.
- **CSRF bypass surface** — any bug that allows bearer auth to be used from a
  browser context (e.g., token leaked to a page) would bypass CSRF. Mitigated
  by never exposing the token in the dashboard's DOM or localStorage.
