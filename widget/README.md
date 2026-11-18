# @pinpoint/widget

Embeddable feedback widget for Pinpoint. Drop a single script tag into any page and let users submit feedback directly to your Pinpoint project.

## Quick Start

```html
<script src="https://your-server.com/widget/pinpoint-widget.js"></script>
<script>
  Pinpoint.init({ projectKey: 'pk_widget_…' });
</script>
```

## Configuration

```html
<script>
  Pinpoint.init({
    // Required: your project widget key. Widget keys are prefixed
    // `pk_widget_`, bound to a single project, and carry only the
    // `widget` scope — they can ONLY submit feedback to that project and
    // are rejected if ever used as an Authorization: Bearer credential.
    projectKey: 'pk_widget_abc123...',

    // Optional: button position (default: 'bottom-right')
    position: 'bottom-right', // 'bottom-left' | 'top-right' | 'top-left'

    // Optional: theme customization
    theme: {
      primaryColor: '#6366f1',
      textColor: '#1f2937',
      bgColor: '#ffffff',
      borderColor: '#e5e7eb',
      errorColor: '#ef4444',
      successColor: '#10b981',
    },

    // Optional: override API URL (auto-detected from script src by default)
    apiUrl: 'https://api.pinpoint.app',
  });
</script>
```

## Widget Keys & Allowed Origins

Widget keys are a dedicated, project-scoped key type — distinct from the
standard `pk_...` Bearer API keys:

- **Prefix** — widget keys start with `pk_widget_`. The standard API Bearer
  path rejects any `pk_widget_` key, so a leaked widget key can never be
  escalated into an authenticated session.
- **Project-bound** — each widget key targets exactly one project (set when
  the key is issued). Feedback submitted with the key always lands in that
  project; there is no org-wide write path.
- **Allowed origins** — a widget key may be restricted to a set of
  `allowedOrigins`. The dedicated `/api/v1/widget/*` CORS layer reflects the
  request `Origin` only when it matches the key's `allowedOrigins`. An empty
  list means "any origin" — convenient for public sites — but the widget
  surface is always **credential-free** (it never sends or accepts cookies),
  so an empty list never exposes a credentialed cross-origin request.
- **Daily quota** — an optional per-key daily submission cap, enforced by a
  fail-closed Redis rate limiter (if the limiter's backend is unreachable,
  submissions are rejected rather than allowed).

Issue a widget key from the dashboard (or `POST /api/v1/api-keys` with
`{ keyType: 'widget', projectId, allowedOrigins?, dailyQuota? }`). The raw
key is shown once at creation.

## Self-Hosted

The API serves the built bundle itself at `GET /widget/pinpoint-widget.js`
(directory set by `WIDGET_DIST_DIR`; the server image sets `/app/widget/dist`)
with `Cross-Origin-Resource-Policy: cross-origin`, so a page on any origin can
load it. Point the script tag at your server:

```html
<script src="https://your-server.com/widget/pinpoint-widget.js"></script>
<script>
  Pinpoint.init({
    projectKey: 'pk_widget_…',
    apiUrl: 'https://your-server.com',
  });
</script>
```

If the dashboard fronts the API through a reverse proxy, it must route
`/widget` to the API (see [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)).

## API

### `Pinpoint.init(config)`

Initializes the widget and renders the feedback button. If called multiple times, the previous instance is destroyed.

### `Pinpoint.destroy()`

Removes the widget from the page.

## Features

- **Shadow DOM isolation** — styles won't conflict with your page
- **Auto-captures environment** — page URL, viewport size, and user agent are sent automatically
- **Lightweight** — target bundle size under 15 KB
- **Accessible** — keyboard navigable, ARIA labels, focus management
- **Rate-limited server-side** — fail-closed per-key limiter with an
  optional daily quota; description text is capped at 2000 characters
  server-side regardless of client input.

## Building

```bash
npm run build --workspace widget
```

The output is written to `widget/dist/pinpoint-widget.js`.

## How It Works

1. The widget injects a floating button into the page using Shadow DOM
2. On click, a feedback form appears with fields for description, severity, and optional email
3. On submit, the widget POSTs to `/api/v1/widget/feedback` with the `X-Project-Key` header
4. The server validates the `pk_widget_` key, resolves the project it is bound to, creates an annotation, and returns the ID
