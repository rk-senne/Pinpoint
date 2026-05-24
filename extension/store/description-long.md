# Pinpoint — Collaborative website feedback

Pinpoint turns any web page into a shared canvas for bug reports, design feedback, and QA notes. Drop a numbered pin anywhere on the page, write a comment, mention a teammate, and the conversation lives right where the issue does — alongside the pixels everyone is talking about.

## Why teams use Pinpoint

Email screenshots and Slack threads lose context fast. By the time a designer reviews a bug, nobody remembers which breakpoint, which build, or which scroll position the screenshot came from. Pinpoint solves that by anchoring every annotation to a resolvable DOM target and the live state of the page when it was created. When a teammate clicks the pin, they jump back to the exact element, viewport size, browser, and route the reporter saw.

## What you can do

- **Pin annotations to any element.** Pins stick to their target through scroll, resize, layout shifts, and SPA navigation. Overlapping pins collapse into a numbered cluster you can expand.
- **Capture context automatically.** Each annotation can attach a viewport screenshot, the recent console log buffer, the recent network request buffer, and structured environment metadata (browser, OS, viewport, URL, route). Sensitive fields are redacted before anything leaves the browser.
- **Talk in threads, not tickets.** Comments support `@mentions` with autocomplete, severity tags, and a status workflow (Open → In Progress → Resolved). Resolved pins fade into the background but stay searchable.
- **Stay in sync.** Real-time presence shows who is on the page with you. New annotations and replies appear instantly across all open tabs through a Socket.IO connection.
- **Keep secrets in.** Inputs marked `type=password`, fields tagged `data-fl-redact`, and elements inside `[data-fl-private]` regions are stripped from screenshots and replays. The first time you open the extension on a new host, a disclosure modal explains exactly what gets sent and links to the privacy policy.

## How it works

Sign in once through the popup. Press `Alt+Shift+F` to toggle the overlay on any allow-listed host, drop a pin, and start typing. Your team sees it live in the dashboard at pinpoint.example, where Project owners can triage, assign, filter by severity, and export. The extension stays out of the way — no injected scripts on pages outside your team's allow-list, no analytics tracking, and no third-party network calls.

## Privacy and data handling

Pinpoint only sends data to the API endpoint your team configures. The full privacy policy ships in this listing under "Privacy practices" and as `privacy-policy.md` in the extension repository. We collect the minimum needed to make annotations useful: your auth token, the annotation body, the optional screenshot or buffers you choose to attach, the page URL, and the resolved selector. We do not sell data, we do not run third-party trackers, and you can revoke access at any time by signing out from the options page.

## Get started

1. Install the extension.
2. Click the toolbar icon and sign in with your Pinpoint account (or create one at pinpoint.example).
3. Open any page on a host your team has enabled, hit `Alt+Shift+F`, and drop your first pin.

Need help? Email support@pinpoint.example or open an issue in the public repository.
