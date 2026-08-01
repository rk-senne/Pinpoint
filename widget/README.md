# @pinpoint/widget

Embeddable feedback widget for Pinpoint. Drop a single script tag into any page and let users submit feedback directly to your Pinpoint project.

## Quick Start

```html
<script src="https://cdn.pinpoint.app/widget.js"></script>
<script>
  Pinpoint.init({ projectKey: 'your-key-here' });
</script>
```

## Configuration

```html
<script>
  Pinpoint.init({
    // Required: your project API key (must have 'widget' scope)
    projectKey: 'pk_live_abc123',

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

## Self-Hosted

If you're self-hosting Pinpoint, serve the built `pinpoint-widget.js` from your server and point the script tag to it:

```html
<script src="https://your-server.com/static/pinpoint-widget.js"></script>
<script>
  Pinpoint.init({
    projectKey: 'your-key-here',
    apiUrl: 'https://your-server.com',
  });
</script>
```

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
- **Rate-limited server-side** — 5 submissions per minute per IP

## Building

```bash
npm run build --workspace widget
```

The output is written to `widget/dist/pinpoint-widget.js`.

## How It Works

1. The widget injects a floating button into the page using Shadow DOM
2. On click, a feedback form appears with fields for description, severity, and optional email
3. On submit, the widget POSTs to `/api/v1/widget/feedback` with the `X-Project-Key` header
4. The server validates the key, creates an annotation, and returns the ID
