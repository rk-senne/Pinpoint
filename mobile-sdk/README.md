# @pinpoint/mobile-sdk

Lightweight, zero-dependency TypeScript client for the Pinpoint API. Works in React Native, Flutter WebView, iOS (via JavaScriptCore bridge), and Android (via WebView JS interface).

## Installation

```bash
npm install @pinpoint/mobile-sdk
```

## Quick Start

```typescript
import { PinpointClient } from '@pinpoint/mobile-sdk';

const client = new PinpointClient({
  baseUrl: 'https://api.pinpoint.dev',
  onAuthRequired: () => navigation.navigate('Login'),
});

// Login
const { token, user } = await client.login('user@example.com', 'password');
client.setToken(token);

// Create feedback
const annotation = await client.createAnnotation('project-id', {
  pageId: 'page-id',
  type: 'note',
  severity: 'major',
  body: 'This button is misaligned on mobile',
  target: { cssSelector: '.submit-btn', xpath: '//button[1]', pageX: 120, pageY: 340, tagName: 'BUTTON', textSnippet: 'Submit' },
  environment: { browserFamily: 'Chrome', browserVersion: '120', osFamily: 'Android', osVersion: '14', deviceType: 'mobile', userAgentRaw: navigator.userAgent },
});

// Upload screenshot
const screenshot = await captureScreen(); // platform-specific
await client.uploadScreenshot(annotation.id, screenshot);
```

## OAuth PKCE Flow

```typescript
import { PinpointClient, generateCodeVerifier, generateCodeChallenge } from '@pinpoint/mobile-sdk';

const client = new PinpointClient({ baseUrl: 'https://api.pinpoint.dev' });

// 1. Generate PKCE pair
const verifier = generateCodeVerifier();
const challenge = await generateCodeChallenge(verifier);

// 2. Get OAuth URL and open in system browser
const url = client.oauthUrl('google', { codeChallenge: challenge });
// Open `url` in in-app browser or system browser

// 3. After redirect, exchange code with verifier
const { token, user } = await client.exchangeOAuthCode('google', authCode, verifier);
client.setToken(token);
```

## Real-time Events

```typescript
client.connect();

const unsub = client.onAnnotationCreated((annotation) => {
  console.log('New annotation:', annotation.pinNumber);
});

client.onNotification((notification) => {
  showPushNotification(notification);
});

// Cleanup
unsub();
client.disconnect();
```

## API Reference

### Constructor

```typescript
new PinpointClient(config: PinpointConfig)
```

| Config Field | Type | Description |
|---|---|---|
| `baseUrl` | `string` | API base URL (no trailing slash) |
| `apiKey` | `string?` | API key for server-to-server auth |
| `token` | `string?` | Bearer JWT token |
| `onAuthRequired` | `() => void` | Called on 401 responses |

### Methods

| Method | Returns | Description |
|---|---|---|
| `setToken(token)` | `void` | Set/update the bearer token |
| `login(email, password)` | `Promise<{ token, user }>` | Email/password login |
| `oauthUrl(provider, options?)` | `string` | Build OAuth redirect URL |
| `exchangeOAuthCode(provider, code, codeVerifier?)` | `Promise<{ token, user }>` | Exchange OAuth code |
| `listProjects(params?)` | `Promise<Project[]>` | List projects |
| `getProject(id)` | `Promise<Project>` | Get project details |
| `listAnnotations(projectId, params?)` | `Promise<Annotation[]>` | List annotations |
| `createAnnotation(projectId, data)` | `Promise<Annotation>` | Create annotation |
| `updateAnnotation(id, data)` | `Promise<Annotation>` | Update annotation |
| `deleteAnnotation(id)` | `Promise<void>` | Delete annotation |
| `changeStatus(id, status)` | `Promise<Annotation>` | Change annotation status |
| `listComments(annotationId)` | `Promise<Comment[]>` | List comments |
| `createComment(annotationId, body)` | `Promise<Comment>` | Add comment |
| `uploadScreenshot(annotationId, imageData)` | `Promise<{ url }>` | Upload screenshot |
| `listNotifications(params?)` | `Promise<{ notifications, unreadCount }>` | List notifications |
| `markRead(notificationId)` | `Promise<void>` | Mark notification read |
| `markAllRead()` | `Promise<void>` | Mark all read |
| `connect()` | `void` | Open WebSocket connection |
| `disconnect()` | `void` | Close WebSocket |
| `onAnnotationCreated(cb)` | `() => void` | Subscribe to new annotations (returns unsub) |
| `onNotification(cb)` | `() => void` | Subscribe to notifications (returns unsub) |

## Platform-Specific Notes

### React Native

Works out of the box. `fetch` and `WebSocket` are available globally. Use `react-native-blob-util` or the built-in `fetch` with `FormData` for screenshot uploads.

### Flutter (WebView)

Use the SDK through a JavaScript bridge in your WebView, or port the HTTP calls to Dart's `http` package using the endpoint mapping in `docs/MOBILE_SDK_SPEC.md`.

### iOS (Swift)

Evaluate the SDK in a `WKWebView` JavaScriptCore context, or use the endpoint mapping to build native `URLSession` calls. PKCE helpers can be ported using `CryptoKit`.

### Android (Kotlin)

Use via WebView's `evaluateJavascript`, or port to `OkHttp`/`Retrofit` using the endpoint mapping. PKCE uses `java.security.MessageDigest` with `SHA-256`.
