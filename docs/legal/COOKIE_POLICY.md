# Cookie Policy

**Last updated: {{EFFECTIVE_DATE}}** · Version 2026-11-27

> **Draft — not legal advice.** Have a lawyer review before relying on it.

Pinpoint ({{COMPANY_NAME}}, {{SERVICE_URL}}) uses **only strictly necessary cookies and browser storage**. We do **not** use analytics, advertising, social-media, fingerprinting or other tracking technologies, so **we do not show a cookie consent banner**. This page tells you exactly what is set, why and for how long, as the law requires us to inform you.

## Why no consent banner is needed

* **EU / UK (ePrivacy Directive Art. 5(3); UK PECR reg. 6):** consent is **not** required for storage or access that is *strictly necessary* to provide a service the user has explicitly requested — here, signing in and staying signed in, protecting your session against cross-site request forgery, unlocking a password-protected shared link you opened, and completing a social-sign-in or integration connection you started. Article 29 Working Party Opinion 04/2012 on the cookie-consent exemption (WP 194) lists authentication, user-centric security and user-interface-customisation cookies as exempt, and the ICO's guidance takes the same approach. The information duty remains and is met by this page.
* **GDPR / POPIA:** the processing involved (keeping you authenticated; security) is necessary for the contract with you and for our legitimate interest in security (GDPR Art. 6(1)(b), (f); POPIA s.11(1)(b), (f)). No consent is relied on, so none can be "refused" or "withdrawn" for these items.
* **CCPA/CPRA:** the cookies are not used to sell or share personal information.

**If this ever changes** (for example we add product analytics) we will update this policy first and add an opt-in consent mechanism **before** setting any non-essential technology.

## Cookies set by the Pinpoint dashboard / API

| Name | Purpose | Set when | Lifetime | Flags |
|---|---|---|---|---|
| `__Host-fl_session` (plain-HTTP local installs use `fl_session`) | Your signed session token; keeps you logged in | You log in; renewed by session refresh | **24 hours** (`Max-Age=86400`); cleared on logout | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` (the `__Host-` prefix forces this) |
| `__Host-fl_csrf` (`fl_csrf` on plain HTTP) | Double-submit anti-CSRF token bound to your session; the dashboard echoes it in the `X-CSRF-Token` header | You log in | **24 hours**; cleared on logout | `Secure`, `SameSite=Lax`, `Path=/` (readable by the dashboard script by design) |
| `fl_shared_access` | Remembers that you entered the correct password for **one** shared link, so guest feedback on it is allowed | You unlock a password-protected shared link | **30 minutes** | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/shared/<link id>` (only sent to that link) |
| `oauth_state` | Signed one-time state that protects Google/GitHub sign-in against forgery | You click "Continue with Google/GitHub" | **10 minutes** | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/auth/oauth` |
| `integration_oauth_state` | Signed one-time state for connecting Slack, Jira, Linear, GitHub, ClickUp or Asana | An admin starts connecting an integration | **10 minutes** | `HttpOnly`, `Secure`, `SameSite=Lax` |

## Browser storage (not cookies)

| Where | Key | Purpose | Lifetime |
|---|---|---|---|
| Dashboard `localStorage` | `pinpoint_theme` | Remembers your light/dark/system choice (a user-requested interface preference). No identifier, never sent to a server. | Until you clear it |
| Browser extension storage (`chrome.storage.local` / `browser.storage.local`) | auth token, **Server URL**, per-site capture preferences | Keeps the extension signed in to your Pinpoint server and remembers your capture choices | Until you sign out or remove the extension |

The dashboard deliberately does **not** keep your session token in `localStorage` or `sessionStorage`; it lives only in the HttpOnly cookie (and, for the real-time connection, in memory until you reload).

## What we do not set

* The **feedback widget** embedded on a customer's website sets **no cookies and uses no `localStorage`/`sessionStorage`**. It sends the feedback you submit (and, only if you type it, your e-mail) with the page address and browser details to the site owner via Pinpoint.
* **Review links** and **client portals** do not set tracking cookies; portal guests identify themselves with a one-time e-mailed link kept in memory only.
* The pages of **third-party websites** you annotate may set their own cookies. Those are governed by those sites; Pinpoint's extension does not read them.

## Managing cookies

You can block or delete cookies in your browser settings; strictly necessary cookies are needed to log in, so blocking them will stop sign-in from working. Because we use no optional cookies there is nothing further to opt out of. Questions: {{CONTACT_EMAIL}}.
