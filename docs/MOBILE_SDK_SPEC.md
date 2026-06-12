# Mobile SDK Specification

## Architecture Overview

The `@pinpoint/mobile-sdk` is a zero-dependency TypeScript package that wraps the Pinpoint REST API (`/api/v1`) into an ergonomic client for mobile platforms. It ships as ESM, uses only native `fetch` and `WebSocket`, and can run in any JavaScript runtime (React Native, WebView, Node.js).

```
┌─────────────────────────────────────────┐
│           Mobile Application            │
│  (React Native / Flutter / iOS / Android)│
├─────────────────────────────────────────┤
│         @pinpoint/mobile-sdk            │
│  ┌───────────┐  ┌──────┐  ┌──────────┐ │
│  │  Client   │  │ PKCE │  │  Types   │ │
│  └─────┬─────┘  └──────┘  └──────────┘ │
│        │ fetch / WebSocket              │
├────────┼────────────────────────────────┤
│        ▼                                │
│   Pinpoint API (server)                 │
│   /api/v1/*                             │
└─────────────────────────────────────────┘
```

## Auth Strategies

### 1. Bearer JWT (Primary — mobile)

- Obtain via `POST /api/v1/auth/login` (email/password) or OAuth PKCE flow.
- Stored client-side (secure storage, e.g. Keychain / EncryptedSharedPreferences).
- Sent as `Authorization: Bearer <token>` on every request.
- CSRF-exempt (proof-of-possession).

### 2. OAuth PKCE (Recommended for production)

- Client generates `code_verifier` + `code_challenge` (S256).
- Opens authorization URL with `code_challenge` param.
- Provider redirects back with `code`; client exchanges with `code_verifier`.
- Server validates S256 and returns `{ token, user }` as JSON (not cookies).

### 3. API Key (Future — server-to-server)

- Issued per-project in dashboard settings.
- Sent as `X-API-Key` header.
- Suitable for CI/CD integrations, automated testing tools.

## Endpoint Mapping

| SDK Method | HTTP Method | Endpoint |
|---|---|---|
| `login` | POST | `/api/v1/auth/login` |
| `oauthUrl` | — (builds URL) | `/api/v1/auth/oauth/:provider` |
| `exchangeOAuthCode` | GET | `/api/v1/auth/oauth/:provider/callback` |
| `listProjects` | GET | `/api/v1/projects` |
| `getProject` | GET | `/api/v1/projects/:id` |
| `listAnnotations` | GET | `/api/v1/projects/:id/annotations` |
| `createAnnotation` | POST | `/api/v1/projects/:id/annotations` |
| `updateAnnotation` | PUT | `/api/v1/annotations/:id` |
| `deleteAnnotation` | DELETE | `/api/v1/annotations/:id` |
| `changeStatus` | PUT | `/api/v1/annotations/:id/status` |
| `listComments` | GET | `/api/v1/annotations/:id/comments` |
| `createComment` | POST | `/api/v1/annotations/:id/comments` |
| `uploadScreenshot` | POST | `/api/v1/annotations/:id/screenshot` |
| `listNotifications` | GET | `/api/v1/notifications` |
| `markRead` | PUT | `/api/v1/notifications/:id/read` |
| `markAllRead` | PUT | `/api/v1/notifications/read-all` |

## Screenshot Capture Strategy

Mobile screenshot capture differs from the extension's DOM-based approach:

1. **Bitmap capture** — platform-native screen capture (React Native: `react-native-view-shot`, iOS: `UIGraphicsImageRenderer`, Android: `PixelCopy`).
2. **Tap coordinates** — record the `(x, y)` tap position relative to the captured view. Map to `target.pageX` / `target.pageY`.
3. **Upload** — send raw PNG/JPEG bytes via `uploadScreenshot()` as `application/octet-stream`.
4. **Element identification** — for WebView-based apps, inject a small script to resolve the tapped element's CSS selector and XPath. For native views, use accessibility identifiers as `cssSelector` equivalent.

## Push Notification Integration Plan

| Platform | Service | Strategy |
|---|---|---|
| iOS | APNs | Register device token via `POST /api/v1/devices`; server pushes via APNs HTTP/2 |
| Android | FCM | Register FCM token via same endpoint; server pushes via FCM v1 API |
| Cross-platform | — | SDK exposes `registerPushToken(platform, token)` method |

Flow:
1. App registers with OS push service → obtains device token.
2. SDK calls `registerPushToken('ios' | 'android', token)`.
3. Server stores token in `device_tokens` table (linked to user).
4. Notification worker (Req 28) fans out to push service alongside email.
5. On token refresh, SDK re-registers transparently.

## Offline Queue Strategy

Mirrors the extension's outbox pattern (Req 44):

1. **Enqueue** — when `fetch` fails (network error or timeout), serialize the request into a local queue (AsyncStorage / SQLite).
2. **Retry** — on network recovery (NetInfo listener), replay queue in FIFO order.
3. **Idempotency** — attach `clientRequestId` (UUID) to create operations; server deduplicates.
4. **Conflict resolution** — server returns existing row on duplicate `clientRequestId`; SDK merges silently.
5. **Bounded queue** — cap at 100 entries; drop oldest if exceeded (with callback notification).

## Error Handling Contract

All SDK methods throw `PinpointApiError` on non-2xx responses:

```typescript
class PinpointApiError extends Error {
  status: number;   // HTTP status code
  body: string;     // Raw response body (may contain JSON error envelope)
}
```

Callers should handle:
- `401` — token expired; `onAuthRequired` callback fires automatically.
- `403` — insufficient permissions.
- `404` — resource not found.
- `409` — conflict (duplicate clientRequestId handled internally).
- `423` — locked (shared link lockout; includes `Retry-After`).
- `429` — rate limited (see below).

## Rate Limiting Considerations

- Server applies per-user rate limits (sliding window).
- SDK reads `Retry-After` header on 429 responses.
- Automatic retry with exponential backoff (1s, 2s, 4s, max 3 attempts).
- `uploadScreenshot` has a separate higher limit (larger payloads).
- Batch operations (future) reduce call count.

## Versioning Strategy

- SDK follows SemVer (`MAJOR.MINOR.PATCH`).
- SDK version is independent of the server API version.
- MAJOR bump = breaking API surface change (method signature, removed method).
- MINOR bump = new methods, non-breaking additions.
- PATCH bump = bug fixes, internal improvements.
- SDK targets `/api/v1`; when `/api/v2` ships, a new major SDK version will target it.
- Minimum supported API server version documented in `README.md`.
