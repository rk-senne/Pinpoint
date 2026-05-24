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

- We do not send page content from hosts outside the allow-list configured by your team. The extension's `host_permissions` are scoped to the explicit allow-list.
- We do not run third-party analytics, advertising, or tracking scripts.
- We do not collect keystrokes, mouse movements, or page activity outside of an annotation submission.
- We redact form inputs of `type="password"`, fields marked with `data-fl-redact`, and elements inside `[data-fl-private]` regions before they enter screenshots, console buffers, or network buffers.

## Where data is stored

Annotations and their attachments are stored on the Pinpoint API server your team operates. Screenshots are written to object storage (S3 or compatible) under a key scoped to your project. Authentication tokens are stored locally in `chrome.storage.local` and never sent to any host other than the configured API origin.

## How to control your data

- **Sign out** from the extension popup or the options page to clear your local auth token. Pending annotations are discarded.
- **Per-host capture toggles** on the options page let you disable screenshots, console logs, or network logs for any specific host.
- **Allow-list management** is controlled by your team's owner in the dashboard. Hosts not on the allow-list will not load the extension's content script.
- **Account deletion**: contact support@pinpoint.example to request deletion of your account and all associated annotations.

## Permissions explained

- `activeTab`, `scripting`: required to inject the annotation overlay into the current tab when you toggle Pinpoint on.
- `storage`: stores your auth token and per-host capture preferences locally.
- `tabs`: used to associate annotations with the correct page URL and to restore overlay state on tab navigation.
- `host_permissions`: scoped to your team's allow-list. The extension does not run on any host outside it.

## Contact

Questions or requests: support@pinpoint.example.
