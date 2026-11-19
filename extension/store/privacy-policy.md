# Pinpoint Privacy Policy

_Last updated: 2025-05-17_

Pinpoint is a collaborative annotation tool. This policy describes what data the Pinpoint browser extension collects, what it transmits, and how to control it.

## What the extension sends to the API

When you submit an annotation, the extension sends the following to the Pinpoint API endpoint your team has configured:

- The annotation body text you typed, including any `@mentions`.
- The page URL of the tab where the annotation was created.
- A resolved DOM selector identifying the element the pin is anchored to.
- Structured environment metadata: browser name and version, operating system, viewport dimensions, device pixel ratio, and the route segment of the URL.
- Optionally, and only when you explicitly enable each capture: a viewport screenshot, the buffered console log entries from the current page, and the buffered network request summaries from the current page.
- Your authentication token, sent as a bearer credential on every request, so the API knows which account submitted the annotation.

The first time you open the extension on a new host, a disclosure modal lists exactly which categories will be sent and lets you toggle each one off before any data leaves your browser.

## What the extension does NOT send

- We do not send page content from hosts you have not chosen to use Pinpoint on. The extension auto-runs only on local development origins; on any other site it runs only after you invoke it there (toolbar click grants `activeTab` for that tab) or grant access to your configured Server URL.
- We do not run third-party analytics, advertising, or tracking scripts.
- We do not collect keystrokes, mouse movements, or page activity outside of an annotation submission.
- We redact form inputs of `type="password"`, fields marked with `data-fl-redact`, and elements inside `[data-fl-private]` regions before they enter screenshots, console buffers, or network buffers.

## Where data is stored

Annotations and their attachments are stored on the Pinpoint API server your team operates. Screenshots are written to object storage (S3 or compatible) under a key scoped to your project. Authentication tokens are stored locally in `chrome.storage.local` and never sent to any host other than the configured API origin.

The **Server URL** (the Pinpoint API/dashboard origin the extension talks to) is configurable on the options page and stored locally in `chrome.storage.local`. It defaults to the origin baked into the build. The extension sends your annotation data and auth token only to this configured origin.

## How the content script reaches the API

The annotation overlay runs as a content script inside the web page you are reviewing. Browser security (CORS) blocks a content script from calling the Pinpoint API directly across origins, so every API request is relayed to the extension's background service worker, which performs the request under the extension's own permissions and returns the result. No annotation data is exposed to the host page during this relay — it travels only between the extension's own content script and service worker.

## How to control your data

- **Sign out** from the extension popup or the options page to clear your local auth token. Pending annotations are discarded.
- **Per-host capture toggles** on the options page let you disable screenshots, console logs, or network logs for any specific host.
- **Server URL** on the options page lets you point the extension at your own deployment. Saving a new URL asks for your permission to reach that origin.
- **Allow-list management** is controlled by your team's owner in the dashboard. Hosts not on the allow-list will not load the extension's content script automatically.
- **Account deletion**: contact support@pinpoint.example to request deletion of your account and all associated annotations.

## Permissions explained

- `activeTab`: when you invoke Pinpoint by clicking its toolbar icon (or signing in from the popup), the browser grants the extension temporary access to that one tab so it can inject the annotation overlay. This access lasts only for that tab and is not a standing permission to read other sites.
- `scripting`: used together with `activeTab` to inject the overlay's content script into the current tab on demand.
- `storage`: stores your auth token, your configured Server URL, and per-host capture preferences locally.
- `tabs`: used to associate annotations with the correct page URL and to restore overlay state on tab navigation.
- `host_permissions` (install-time): scoped to local development origins only (`http://localhost`, `http://127.0.0.1`). The extension does not request standing access to any website at install time.
- `optional_host_permissions` (requested at runtime, never at install): the extension can request access to a site only when you choose to use it there — temporarily per-tab via `activeTab` when you click the toolbar icon, or as a durable grant for your configured Server URL, which the options page requests from you with a browser permission prompt. You can review and revoke these grants at any time from `chrome://extensions`.

## Contact

Questions or requests: support@pinpoint.example.
