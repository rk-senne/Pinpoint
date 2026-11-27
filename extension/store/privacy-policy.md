# Pinpoint Privacy Policy

_Last updated: {{EFFECTIVE_DATE}}_

Pinpoint is a collaborative annotation tool. This policy describes what data the Pinpoint browser extension collects, what it transmits, and how to control it. It summarises the extension; the full [Privacy Policy]({{SERVICE_URL}}/legal/privacy) (also covering the dashboard, widget and your rights under GDPR, UK GDPR, POPIA and CCPA), the [Terms of Service]({{SERVICE_URL}}/legal/terms), the [Cookie Policy]({{SERVICE_URL}}/legal/cookies) and the [Sub-processors]({{SERVICE_URL}}/legal/subprocessors) list are published at {{SERVICE_URL}}/legal/privacy.

**Who is responsible.** For your account, {{COMPANY_NAME}} ({{COMPANY_ADDRESS}}) is the controller / responsible party. For the annotations you create, the team (organisation) whose Pinpoint server the extension is connected to is the controller and {{COMPANY_NAME}} acts as its processor / operator. If your team runs its own Pinpoint server, that team is responsible and {{COMPANY_NAME}} receives nothing.

## What the extension sends to the API

When you submit an annotation, the extension sends the following to the Pinpoint API endpoint your team has configured:

- The annotation body text you typed, including any `@mentions`.
- The page URL of the tab where the annotation was created.
- A resolved DOM selector identifying the element the pin is anchored to.
- Structured environment metadata: browser name and version, operating system, viewport dimensions, device pixel ratio, and the route segment of the URL.
- Optionally, and only when you explicitly enable each capture: a viewport screenshot, the buffered console log entries from the current page, and the buffered network request summaries from the current page.
- A short, redacted buffer (about the last 10 seconds) of page interaction events — clicks, scrolls, input changes and DOM mutations — attached to the annotation you submit, for replay in the dashboard. Password fields and `data-fl-redact` elements are masked before capture.
- Your authentication token, sent as a bearer credential on every request, so the API knows which account submitted the annotation.

The first time you open the extension on a new host, a disclosure modal lists exactly which categories will be sent and lets you toggle each one off before any data leaves your browser.

## What the extension does NOT send

- We do not send page content from hosts you have not chosen to use Pinpoint on. The extension auto-runs only on local development origins; on any other site it runs only after you invoke it there (toolbar click grants `activeTab` for that tab) or grant access to your configured Server URL.
- We do not run third-party analytics, advertising, or tracking scripts.
- We do not send keystrokes, mouse movements, or page activity unless they are part of the replay buffer attached to an annotation you submit.
- We redact form inputs of `type="password"`, fields marked with `data-fl-redact`, and elements inside `[data-fl-private]` regions before they enter screenshots, console buffers, or network buffers.

## Where data is stored

Annotations and their attachments are stored on the Pinpoint API server your team operates. Screenshots are written to object storage (local disk on the server, or S3-compatible storage) under a key scoped to your project. Authentication tokens are stored locally in the browser's extension storage (`chrome.storage.local`; `browser.storage.local` in Firefox and Safari) and never sent to any host other than the configured API origin.

The **Server URL** (the Pinpoint API/dashboard origin the extension talks to) is configurable on the options page and stored locally in the browser's extension storage (`chrome.storage.local`; `browser.storage.local` in Firefox and Safari). It defaults to the origin baked into the build. The extension sends your annotation data and auth token only to this configured origin.

## How the content script reaches the API

The annotation overlay runs as a content script inside the web page you are reviewing. Browser security (CORS) blocks a content script from calling the Pinpoint API directly across origins, so every API request is relayed to the extension's background service worker, which performs the request under the extension's own permissions and returns the result. No annotation data is exposed to the host page during this relay — it travels only between the extension's own content script and service worker.

## How to control your data

- **Sign out** from the extension popup or the options page to clear your local auth token. Pending annotations are discarded.
- **Per-host capture toggles** on the options page let you disable screenshots, console logs, or network logs for any specific host.
- **Server URL** on the options page lets you point the extension at your own deployment. Saving a new URL asks for your permission to reach that origin.
- **Allow-list management** is controlled by your team's owner in the dashboard. Hosts not on the allow-list will not load the extension's content script automatically.
- **Export and deletion**: in the Pinpoint dashboard open **Settings → Privacy** to download a copy of your data or delete your account. Deleting your account removes your profile, sign-in and notifications; annotations and comments you wrote in a team that continues to exist stay in that team's project history, attributed to "Deleted user" (team admins can delete them). To have specific content removed, ask the team's admins or write to {{CONTACT_EMAIL}}.
- **Complaints**: contact us first at {{CONTACT_EMAIL}} (Information Officer: {{INFORMATION_OFFICER}}). You may also complain to the South African Information Regulator (POPIAComplaints@inforegulator.org.za), your EU/UK data-protection authority, or the California Attorney General.

## Permissions explained

- `activeTab`: when you invoke Pinpoint by clicking its toolbar icon (or signing in from the popup), the browser grants the extension temporary access to that one tab so it can inject the annotation overlay. This access lasts only for that tab and is not a standing permission to read other sites.
- `scripting`: used together with `activeTab` to inject the overlay's content script into the current tab on demand.
- `storage`: stores your auth token, your configured Server URL, and per-host capture preferences locally.
- `tabs`: used to associate annotations with the correct page URL and to restore overlay state on tab navigation.
- `host_permissions` (install-time): scoped to local development origins only (`http://localhost`, `http://127.0.0.1`). The extension does not request standing access to any website at install time.
- `optional_host_permissions` (requested at runtime, never at install): the extension can request access to a site only when you choose to use it there — temporarily per-tab via `activeTab` when you click the toolbar icon, or as a durable grant for your configured Server URL, which the options page requests from you with a browser permission prompt. You can review and revoke these grants at any time from `chrome://extensions`.

## Contact

Questions or requests: {{CONTACT_EMAIL}}.
