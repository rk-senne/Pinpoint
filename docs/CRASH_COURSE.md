# Pinpoint: Manager Crash Course

A 10 to 15 minute walkthrough for non-technical readers. It also works as a presenter script. The live-demo steps are in the [Appendix](#appendix-live-demo-script).

Status as of 15 Nov 2026, branch `feat/enhancement-roadmap`. The work is uncommitted and not yet released.

All screenshots come from a real running copy of Pinpoint, filled with a made-up agency workspace. Images are linked relative to this file, so it renders correctly inside `docs/`.

---

## 1. What Pinpoint is

**Pinpoint lets people click on any spot of a live website and leave feedback right there. The feedback arrives with the details a developer needs to fix it.**

**The problem.** Website feedback today is scattered across email threads, screenshots pasted into Slack, and spreadsheets. "The button on the pricing page is broken" arrives without the browser, the screen size, the exact element, or what went wrong behind the scenes. Developers lose time asking follow-up questions, and nobody can see at a glance what is open or done.

**The fix.** Each piece of feedback becomes a numbered pin on the page. Pinpoint automatically attaches the browser and operating system, the page address, the exact element, and, where captured, error messages and a short recording of what the reviewer did. Everything then lands in one shared dashboard.

---

## 2. Who uses it, and the three ways feedback gets in

| Who | What they do in Pinpoint |
|---|---|
| **Agency or product team** (designers, QA, project managers) | Review sites, triage feedback, assign work, report progress |
| **Clients and stakeholders** | Leave feedback or view progress, often without making an account |
| **Developers** | Get precise, reproducible reports. They can push them into Jira, Linear, GitHub and so on |

There are three ways to capture feedback. Pick whichever suits the reviewer.

### a) Chrome extension: for your own team

Team members install a Chrome extension, click any element on any site, and write a note. They choose a type (Note, Suggestion or Guideline) and a severity colour. The popover shows exactly what will be attached, such as browser and OS.

![Extension popover: a reviewer types feedback on a live page. The popover shows "Will attach: Chrome 148 · Windows · desktop" and an "Attach screenshot" checkbox.](screenshots/extension-popover-create.png)

*The reviewer chooses a type and severity and sees what will be attached before submitting.*

The first time, the extension shows a plain-language disclosure of what data it sends. It lists selectors, optional screenshot, console and network buffer, browser and OS, and page URL. It also says sensitive areas such as password fields are blurred.

![First-use disclosure listing every category of data the extension transmits, with Acknowledge and Open Settings buttons.](screenshots/extension-disclosure.png)

### b) Embeddable widget: one script tag, any website

A site owner pastes a small snippet before `</body>`. A feedback button then appears for every visitor, with no install and no account. The form asks for a description, a severity and an optional email.

![A sample shop site "Bloom & Co" with a round feedback button at the bottom right.](screenshots/widget-closed.png)

![The widget form: description, severity, optional email, Cancel and Submit.](screenshots/widget-open-desktop.png)

![After submitting: "Thank you! Your feedback has been submitted."](screenshots/widget-success.png)

### c) Review links: no install at all, ideal for clients

You send a link. The client opens it and sees a live preview of the page with a **Send feedback** button. It works without an extension or snippet.

![A review-link page: sidebar explaining the preview, the page in a frame, and a Send feedback button at the bottom right. The demo target is the example.com placeholder page.](screenshots/review-desktop.png)

*Honest limit: some sites forbid being shown inside another page, and sites that only render after login show their logged-out view. For those, use the extension or widget.*

---

## 3. Guided tour

### Step 1: Sign in

A standard email and password login. New accounts must verify their email first. The first verified login creates a personal workspace (an "organization") automatically.

![Login screen with Email, Password and a Log In button.](screenshots/auth-desktop.png)

### Step 2: Onboarding in four steps

A wizard takes a new user from nothing to a working install: **Choose a project → Create a widget key → Add the snippet to your site → Verify your install**.

![Onboarding step 1: pick an existing project or create one with a name and website URL. Four numbered steps across the top.](screenshots/onboarding-1-project-desktop.png)

![Onboarding step 2: issue a widget key. It is shown once, and you can restrict it to specific website origins.](screenshots/onboarding-2-key-desktop.png)

![Onboarding step 3: the ready-to-paste embed snippet with a Copy button. Buttons also offer the browser extension and a review link.](screenshots/onboarding-3-snippet-desktop.png)

![Onboarding step 4: "Waiting for your first piece of feedback". The page checks every 3 seconds for up to 2 minutes.](screenshots/onboarding-4-verify-desktop.png)

*Talking point: the wizard waits for the first real piece of feedback to arrive. That confirms the install works end to end.*

### Step 3: A reviewer leaves feedback

This is the extension or widget flow from section 2. Each submission becomes a numbered pin and appears in the dashboard within moments.

### Step 4: It shows up in the dashboard

The home screen lists projects, with a bell for notifications.

![Dashboard home: the project sidebar (Northwind Client Portal, Acme Marketing Site), a Recent Projects list, and a notification bell.](screenshots/home-desktop.png)

Opening a project shows the **list view**. Summary boxes at the top count feedback by severity, type, status and browser. Each row shows severity and status. Feedback from anonymous visitors carries an "Unverified guest" badge.

![Project list view: counts by severity/type/status/browser, search and filters, and a table of 7 feedback items.](screenshots/project-list-desktop.png)

The **kanban view** shows the same items as cards in Open, In Progress and Resolved columns, and cards can be dragged between columns.

![Kanban board: Open (3), In Progress (2), Resolved (2).](screenshots/project-kanban-desktop.png)

Opening one item shows the **detail view**. For a bug like "Checkout button does nothing on iPhone Safari", it shows a "Reported on Safari 17.5 on iOS 17.5" line, expandable environment details, and a **Console & errors** section. The error messages the page produced are captured automatically, which is often the clue a developer needs. Where a recording was captured, the item can also play back a **session replay**: the reviewer's mouse movements, scrolls and clicks.

### Step 5: Team collaboration

On the same detail screen the team can:

- **Comment** and **@mention** teammates by name.
- **Assign** the item to a person and set a **due date**.
- Get **notifications**: the bell icon in the dashboard, plus optional emails.
- Work **in real time**. New pins, comments and status changes appear for everyone without a page refresh.

![Feedback detail: bug report badge, environment line, Console & errors (3), Send to… button, assignee and due date, and a comment thread where Daniel replies to Maya with an @mention.](screenshots/project-detail-desktop.png)

### Step 6: Send it to your tracker

The purple **Send to…** button on the detail screen creates a task in the team's existing tool. The code supports **GitHub, Linear, Jira, ClickUp and Asana**. The Integrations page also lists Slack. Connecting uses each provider's normal sign-in flow, and secrets are stored encrypted.

![Integrations page with Connect buttons for Slack, Jira, Linear and GitHub.](screenshots/integrations-desktop.png)

*Honest note: integrations have been tested against simulated providers, not live Jira or GitHub accounts. See [section 9](#9-known-limitations-and-roadmap).*

### Step 7: Analytics, heatmap and reports

- **Analytics**: the four count boxes at the top of every project.
- **Heatmap**: a map of where on the page feedback clusters. Each square is a spot and the colour shows severity.
- **Reports**: feedback volume (last 30 days), resolution rate, and a per-person activity summary.
- **Workflow Automation**: rules and SLA (response-time) policies. This page exists but starts empty.

![Heatmap view: coloured squares mark where on the page feedback was left, above the feedback table.](screenshots/project-heatmap-desktop.png)

![Reports page: Feedback Volume "6 new (last 30 days)", Resolution Rate 33%, Team Activity for two members.](screenshots/reports-desktop.png)

### Step 8: Share with clients

Two options:

- **Password-protected shared link**: a read-only view of a project's feedback. The visitor has to enter the password, and repeated wrong attempts lock the link for 15 minutes.
- **Review link**: the no-install feedback page from section 2c.

![A shared link asks for a password before showing anything.](screenshots/shared-locked-desktop.png)

![After unlocking (or for a link without a password): a read-only list of the project's feedback showing pin, type, severity, status and text. No names, emails or technical diagnostics are exposed.](screenshots/shared-open-desktop.png)

There is also a **Client Portals** page. It is present but empty in the demo, and it is not part of this walkthrough.

### Step 9: Settings, teams and invitations

Settings has Profile, Notifications (email toggles per event), Guidelines (Nielsen's 10 usability heuristics are pre-loaded and you can add your own), Teams, and Appearance (light, dark or follow-system).

![Settings → Teams: a "Design & QA" team with Maya as Owner and Daniel as Viewer, plus an invite-by-email box.](screenshots/settings-teams-desktop.png)

![Settings → Notifications: switches for new annotations, new comments, promotions and project deletion.](screenshots/settings-notifications-desktop.png)

New colleagues join through an emailed invitation link.

![Invitation page: "Join organization", with an Accept invitation button.](screenshots/invitations-accept-desktop.png)

### Works on phones too

The dashboard adapts to small screens. The phone view is meant for reviewing, with the full detail, comments and assignment available.

![Feedback detail on a phone-sized screen, with the same environment info, assignment and comments in a single column.](screenshots/project-detail-mobile.png)

---

## 4. Plugs into any company

| Need | How Pinpoint answers it |
|---|---|
| "We can't change our site much." | One `<script>` tag. The key is tied to one project and can be limited to your domains. |
| "We don't want to touch the site at all." | The Chrome extension or a review link. |
| "Clients won't install anything." | Review links and the widget need no install or account. |
| "Tell our other systems." | **Webhooks**: signed notifications to your own endpoints. Deliveries are queued and retried. |
| "Use our task tracker." | One-click send to Jira, Linear, GitHub, ClickUp or Asana. |
| "Let scripts and AI agents help." | **API keys** for automation, and an **MCP server**. MCP is a standard way for AI assistants to use tools. Here an agent can list feedback, read it with its diagnostics, change status and add comments. |
| "Host it ourselves." | Self-host with Docker: `docker compose up` locally, or `deploy/docker-compose.prod.yml` on any Linux VPS (Caddy provides automatic HTTPS). The server refuses to start in an exposed setup if secrets are weak. |
| "Our IT uses a reverse proxy." | The dashboard and API share one web address, so it sits behind a standard proxy or load balancer. `docs/DEPLOYMENT.md` lists the routes. |

---

## 5. Trust and security, in plain language

This is based on our own tests and audits. There are **no formal certifications** such as SOC 2 or ISO 27001, and none are claimed.

- **Each organization's data is kept separate.** An independent audit found places where one customer could reach another's data. These have been fixed, including real-time connections, with tests.
- **Sessions can be revoked.** Logging out or removing a member now ends their existing sessions.
- **Secrets are encrypted at rest.** The OAuth tokens and client secrets for integrations are stored encrypted.
- **Server-side request protection (SSRF).** Wherever Pinpoint fetches an outside web address (webhooks, review links), it blocks internal and private network addresses.
- **Review pages are sandboxed.** The framed third-party page can't touch the dashboard's login or data.
- **Rate limiting.** Limits apply per IP, per organization, on logins, and on widget submissions.
- **Safe defaults for self-hosting.** An exposed deployment won't boot with placeholder secrets, wildcard CORS, a default DB password or insecure cookies.
- **Sensitive screen areas are blurred.** Password and card fields are masked in screenshots before they are stored.
- **Accessibility.** The design targets WCAG AA colour contrast, automated accessibility (axe) scans run on the dashboard and widget pages, and the main flows work from the keyboard.
- **What was audited.** A two-part security audit on 15 Nov 2026 found 1 critical and about 12 high-severity issues. All were fixed with tests. Known-vulnerable dependencies fell from 33 to 3, which are moderate and dev-only.

---

## 6. Quality evidence

As of 15 Nov 2026:

- **2,468 automated unit and integration tests pass** (225 test files, run twice), many against a real PostgreSQL database rather than a stand-in.
- **211 end-to-end tests pass** (API, dashboard, widget, and the actual Chrome extension loaded into Chromium). The dashboard tests run on Chromium, Firefox and WebKit, the engine behind Safari.
- **Accessibility scans** (axe) run on every dashboard page at desktop and phone sizes, and on the widget: zero critical or serious findings, down from 74 at the start of the pass.
- **Production-image simulation.** The production Docker image is started and checked: migrations, health check, widget file, protected metrics endpoint, and a clean shutdown.
- **UI pass.** The latest pass fixed about 40 interface bugs and produced the 72+ screenshots used here.

Many defects were found only by running the full system, not by unit tests. For example, self-registered users could not log in, and the extension was rejected by Chrome. All were fixed.

---

## 7. Competitive position

From our research notes in `docs/ENHANCEMENT_ROADMAP.md` (Nov 2026). Competitor columns come from that document and were not re-checked for this course.

| Capability | Marker.io | BugHerd | Pastel | Userback | Pinpoint |
|---|---|---|---|---|---|
| Browser extension | Yes | Yes | No | Yes | Yes |
| Embeddable widget | Yes | Yes | Yes | Yes | Yes |
| No-install review link | Yes | Yes | Yes | No | Yes |
| Reviewer needs no login | Yes | Yes | Yes | Yes | Yes (widget and review links) |
| Auto browser/OS details | Yes | Yes | Yes | Yes | Yes |
| JS error and console capture | Yes | Yes | No | Yes | Yes |
| Screenshot / session replay | Yes | Yes | Yes | Yes | Yes |
| Send to Jira/Linear/GitHub etc. | Yes | Yes | Partial | Yes | Yes (5 trackers, simulated testing) |
| Signed webhooks | Yes | Yes | No | Yes | Yes |
| **Self-hostable** | No | No | No | No | **Yes** |
| **MCP server for AI agents** | No | No | No | No | **Yes** |

**Our edge** is self-hosting, the AI-agent (MCP) interface, and real-time collaboration. **Where we are behind** is maturity. These tools have years of customers, live-tracker testing, polish and support. Pinpoint is not yet released, and the research notes record one competitor, QualityHive, as also offering an MCP server.

Pricing: `docs/BUSINESS_ANALYSIS.md` (a May 2026 draft) proposes Free, Pro $19, Team $49 and Business $99 plans. These are planning figures, not a published price list.

---

## 8. Known limitations and roadmap

Plain list of what is not finished:

- **Integrations tested against simulated providers only.** No live Jira, GitHub, Linear, ClickUp or Asana accounts have been used. Run a pilot against real accounts before relying on them.
- **Extension sign-in stays signed in across browser restarts.** The token is kept in the extension's own storage, which web pages can't read; sessions expire after at most 30 days and can be revoked from the server at any time.
- **Screenshot storage needs S3-compatible storage configured.** Without it, screenshot upload fails with a visible error. You can see this in the extension screenshots, which were taken on a local stack with no storage set up.
- **Firefox extension is early.** It builds and loads in Firefox without errors, but hasn't had a full hands-on test. There is no Safari extension. The widget and review links work in any browser.
- **Review links can't show every site.** Sites that refuse to be framed, or that need a login to render, won't display.
- **Deployment.** The team deploys with the provider-neutral Docker Compose stack in `deploy/` (see `docs/DEPLOYMENT.md`); images are published to GitHub Container Registry by CI. Deploys are manual (pull, migrate, `up -d`), so check the pre-deploy checklist before each rollout.
- **Some pages are thin.** Workflow Automation and Client Portals are built but were empty in the demo data.
- **Not released yet.** All of this sits on a feature branch awaiting review and merge.
- **No certifications.** There is no SOC 2 or ISO attestation and no third-party penetration test report.

---

## 9. FAQ

**What does it cost to run, who hosts the data, and how long does it take to install?** Pinpoint is self-hosted, so you pay only for your own infrastructure. It needs a PostgreSQL database and a small Node service, plus optional Redis, email (SMTP) and S3-compatible storage for screenshots. For hosting costs, use your provider's own pricing calculator, as I haven't estimated them. Your data stays on infrastructure you control, in your database and your storage bucket. The Pinpoint team doesn't see it. On a laptop with Docker, `docker compose up` starts the database, API, dashboard and a catch-all mailbox in one command. I haven't timed it, but the first run builds images, so allow several minutes. A production setup needs real secrets and a domain, and the repo's deployment guide covers it. A site owner adds feedback to a website by pasting one snippet, which takes minutes.

---

## Appendix: Live-demo script

### Before the meeting: start the stack

**Easiest.** From the repo root, run `docker compose up`. Then open the dashboard at http://localhost:4173, with the API at http://localhost:3001. Sent emails show up in the Mailpit inbox at http://localhost:8025.

**Manual alternative.** Follow the manual setup in `README.md`. You need PostgreSQL, `npm install`, migrations (`npm run migrate`), the server (`npm start` in `server/`), and the dashboard (`npm run dev` in `dashboard/`, at http://localhost:5173).

**Demo login.** Email `maya.chen@acmestudio.dev`, password `Sunr1se-Studio-Demo!` (from `e2e/browser/demo.ts`). That file also builds the demo data: the "Acme Marketing Site" project with 7 feedback items, comments and a teammate, Daniel Okafor. It is created by running the browser test suite (`npm run test --workspace e2e`), which needs the stack up and a local `psql`. The stack is not seeded automatically. If the Maya account doesn't exist, register a new account and create your own project.

**Before you start:** log in once and open the Acme project so you know it works. Screenshot upload will show an error unless S3 storage is configured, so don't promise screenshots in the live demo.

### Script (about 8 steps)

1. **Log in.** *Click:* open the dashboard, sign in as Maya. *Say:* "This is the team's home base. The sidebar lists our client projects, and the bell shows what needs attention."
2. **Open Acme Marketing Site.** *Click:* the project in the sidebar. *Say:* "These four boxes tell us at a glance what's open, how bad it is, and which browsers people use. Notice one item is badged 'Unverified guest'. That came from an anonymous visitor."
3. **Open the critical item (#2).** *Click:* the "Checkout button does nothing…" row. *Say:* "A developer gets the browser, the phone, the error messages and a recording. They don't have to email the reporter and ask." Expand **Environment details** and **Console & errors**.
4. **Collaborate.** *Click:* the comment box and type a short reply with an @mention. Point at the assignee and due date. *Say:* "Comments, owners and deadlines live on the item. Teammates see updates instantly."
5. **Send to a tracker.** *Click:* **Send to…** to show the menu of trackers. *Say:* "One click creates the task in Jira, Linear, GitHub, ClickUp or Asana, once connected." Be honest that live-tracker testing is still to come.
6. **Switch views.** *Click:* **Kanban**, drag a card to another column, then **Heatmap**. *Say:* "Same data as a board, and as a map of where on the page people complain."
7. **Show how feedback gets in.** Open the extension on a demo site and click an element to show the popover. Then show the widget on a site with the snippet, and the **Integrations** / onboarding page for the snippet. *Say:* "Three ways in: extension for the team, one snippet for any site, or a review link for clients with nothing to install."
8. **Share with a client.** *Click:* the project's share option, or open a shared link in a private window, and show the password prompt. *Say:* "Clients get a read-only view behind a password, and the link locks after repeated wrong tries." Close with **Reports** for the numbers managers care about.

**If something goes wrong:** the screenshots in this document show every screen above. Switch to them rather than debugging live.
