# Requirements Document

## Introduction

Pinpoint is a collaborative website feedback tool for internal use, consisting of a Chrome Extension and a Web Application. It enables designers, developers, marketers, and UX researchers to annotate live websites with notes, bugs, and usability improvements by placing feedback directly on page elements. Pinpoint supports real-time collaboration, heuristic evaluations, bug reporting, project management, team management, and PDF/CSV report export — eliminating the need for screenshots and accelerating website review cycles. All features are available to all users (no subscription tiers).

This revision of the requirements adds environment capture (browser and OS detection) on annotations, hardens authentication and session handling, completes real-time wiring gaps, makes annotation pin placement resilient to layout changes, formalizes a Page entity, eliminates pin-number race conditions, refines the shared-link lockout policy, introduces API versioning, mandates a single shared color and label palette, requires structured logging, makes the notification queue durable, prescribes a containerized development setup with continuous integration, and migrates the user interface implementation away from React to vanilla TypeScript with Web Components for the Extension and native modules for the Dashboard while preserving feature parity.

## Glossary

- **Extension**: The Pinpoint Chrome Extension (Manifest V3) that injects an overlay onto any website, enabling annotation placement, a floating toolbar, and a sidebar panel.
- **Dashboard**: The Pinpoint Web Application used for project management, team management, user settings, and report viewing.
- **Annotation**: A feedback item pinned to a specific DOM element on a live website, containing a type (Note, Suggestion, or Guideline), a text body, optional @mentions, and a color-coded severity level.
- **Annotation_Pin**: A numbered badge displayed on the website overlay at the position of an Annotation.
- **Popover**: The UI panel that appears when a user clicks on a website element via the Extension, containing tabs for Note, Suggestion, and Guideline input.
- **Project**: A container associated with one or more Pages, holding all Annotations, team assignments, and metadata. A Project has a status of Active or Archived.
- **Page**: A first-class entity representing a single URL within a Project, with id, project_id, url, title, and created_at fields. Annotations reference a Page via page_id.
- **Sidebar_Panel**: The panel within the Extension that displays a list of active and resolved Annotations for the current Project.
- **Floating_Toolbar**: A bottom-anchored toolbar displayed by the Extension when active, containing close, user avatar, share, and link buttons.
- **Guideline**: A predefined evaluation criterion used during heuristic evaluations, such as one of Nielsen's 10 Heuristics or a custom guideline created by the user.
- **Heuristic_Evaluation**: A structured UX audit conducted by applying a set of Guidelines to a website within a Project.
- **Team**: A named group of users with role-based access to shared Projects.
- **Member**: A user who belongs to a Team, with a role of Owner, Admin, or Viewer.
- **Report**: A PDF document exported from a Project containing all Annotations, severities, and metadata.
- **Severity**: A color-coded classification assigned to an Annotation indicating its priority level (Critical, Major, Minor, or Informational).
- **Severity_Colors**: The single shared map from Severity to hex color value, exported by the shared library and consumed unchanged by both the Extension and the Dashboard.
- **Status_Labels**: The single shared map from annotation status (`active`, `in_progress`, `resolved`) to its human-readable label, exported by the shared library and consumed unchanged by both the Extension and the Dashboard.
- **Mention**: An @mention reference to a specific Member within an Annotation comment, triggering a notification.
- **Notification_Preferences**: User-configurable email toggle settings for events such as new annotations, new comments, ownership promotions, and project deletions.
- **Notification_Queue**: A durable, persistent queue (backed by a `notifications` database table) used by the API_Server to schedule, retry, and record outbound notifications.
- **API_Server**: The backend service providing RESTful endpoints for authentication, project CRUD, annotation CRUD, team management, and real-time WebSocket connections.
- **Collaboration_Service**: The real-time subsystem using WebSockets to synchronize Annotation state and Member presence across connected Members.
- **Browser_Family**: The detected browser product family for an Annotation, restricted to one of: Chrome, Edge, Safari, Firefox, Opera, Brave, Arc, Other, or `unknown`.
- **OS_Family**: The detected operating system family for an Annotation, restricted to one of: macOS, Windows, Linux, iOS, Android, ChromeOS, Other, or `unknown`.
- **Device_Type**: The detected device form factor for an Annotation, restricted to one of: desktop, tablet, or mobile.
- **Environment_Metadata**: The combined record of Browser_Family, browser version, OS_Family, OS version, Device_Type, and the raw User-Agent string captured at Annotation creation time.
- **User_Agent_Parser**: The deterministic library (such as `bowser` or `ua-parser-js`) used to derive Environment_Metadata from a raw User-Agent string.
- **CSRF_Token**: A random, per-session token issued by the API_Server alongside the session cookie and required on every state-changing Dashboard request, implementing the double-submit cookie pattern.
- **Email_Verification**: The process by which a newly registered user receives a single-use, time-limited token by email and proves ownership of the email address by submitting the token before the API_Server will issue an authenticated session.
- **Session_Cookie**: The httpOnly, Secure, SameSite=Lax cookie issued by the API_Server to the Dashboard browser to identify an authenticated session.
- **Bearer_Token**: The JWT used by the Extension as `Authorization: Bearer <token>` for REST calls and as the auth payload for WebSocket connections, stored in `chrome.storage.local`.
- **Common_Passwords_Blocklist**: A bundled list of commonly leaked passwords against which user-supplied passwords are checked at registration and password change.
- **Shared_Link_Lock**: The state in which a shared Project link is temporarily inaccessible after 3 consecutive incorrect password attempts; the lock expires after 15 minutes.
- **Project_Pin_Sequence**: A per-Project monotonic counter, implemented as a Postgres sequence or an `UPDATE … RETURNING` row counter, used to assign a unique, gap-permitted pin number to each new Annotation in a Project.
- **API_Version_Prefix**: The path segment `/api/v1/` under which all current API routes are served. The legacy `/api/` prefix is retired.
- **Structured_Logger**: The single logging library (such as `pino`) used by the API_Server to emit one JSON record per HTTP request and one JSON record per logged error, replacing direct `console.error`/`console.log` use.
- **Web_Component**: A Custom Element (with Shadow DOM where appropriate) used by the Extension as the unit of UI composition, in place of React components.
- **Bearer_Token_Refresh**: The process by which the Extension exchanges a valid or recently-expired Bearer_Token for a fresh one via `POST /api/v1/auth/refresh`.
- **Capture_Buffer**: A rolling, length-bounded log of console messages and Resource Timing entries maintained by the Extension while the overlay is enabled.
- **Cluster_Pin**: A merged pin rendered when multiple Annotation_Pins would overlap within the cluster radius.
- **Markup_Document**: The vector overlay JSON describing user-drawn shapes, arrows, strokes, and pixelate regions on a captured screenshot.
- **PII_Redaction**: The process of automatically masking elements deemed sensitive (passwords, credit-card fields, opt-in `data-fl-redact` elements) in screenshots and replays.
- **Sync_Conflict_Tray**: A user-facing list inside the Extension where queued offline operations that the server rejected on replay can be reviewed and resolved.
- **Domain_Layer**: The infrastructure-free core of the API_Server, containing entities, value objects, domain errors, Use_Cases, and Port interfaces.
- **Inbound_Port**: The TypeScript interface a Use_Case exposes to its callers; inbound adapters depend on this interface to invoke the Use_Case.
- **Outbound_Port**: The TypeScript interface a Use_Case requires to interact with infrastructure (repositories, mailers, storage, clocks, event buses); outbound adapters implement this interface.
- **Use_Case**: A single application action implemented as a class or function in the Domain_Layer that orchestrates entities and ports to fulfill a request from an Inbound_Port.
- **Inbound_Adapter**: A module under `server/src/adapters/inbound/` that translates an external trigger (HTTP request, WebSocket event, queue tick) into a Use_Case invocation.
- **Outbound_Adapter**: A module under `server/src/adapters/outbound/` that implements an Outbound_Port using a concrete infrastructure technology.
- **Composition_Root**: The single module (`server/src/composition/container.ts`) that constructs concrete adapters and injects them into Use_Cases at process boot.

## Requirements

### Requirement 1: User Authentication and Account Management

**User Story:** As a user, I want to register, log in, and manage my account, so that I can securely access Pinpoint and maintain my profile.

#### Acceptance Criteria

1. WHEN a user submits a valid registration form with email, password, and name, THE API_Server SHALL create the user account in an unverified state and trigger Email_Verification.
2. WHEN a user clicks a valid Email_Verification link before the token's expiration, THE API_Server SHALL mark the user as verified and allow the user to log in.
3. IF a user attempts to log in before Email_Verification has been completed, THEN THE API_Server SHALL refuse to issue a Session_Cookie or Bearer_Token and return an error response indicating that email verification is required.
4. WHEN a verified user submits valid login credentials from the Dashboard, THE API_Server SHALL establish a session by issuing a Session_Cookie with the `httpOnly`, `Secure`, and `SameSite=Lax` attributes and a separate readable CSRF_Token cookie.
5. WHEN a verified user submits valid login credentials from the Extension, THE API_Server SHALL return a Bearer_Token in the response body for storage in `chrome.storage.local`.
6. IF a user submits invalid login credentials, THEN THE Dashboard SHALL display an error message indicating the credentials are incorrect.
7. WHEN a user navigates to the Profile page, THE Dashboard SHALL display the user's personal information with editable fields for name, email, and avatar.
8. WHEN a user saves changes on the Profile page, THE Dashboard SHALL persist the updated profile information and display a confirmation message.
9. WHEN a user requests a password reset, THE API_Server SHALL send a password reset email containing a single-use, time-limited reset link.
10. THE API_Server SHALL require submitted passwords to be at least 10 characters long.
11. IF a submitted password appears in the Common_Passwords_Blocklist, THEN THE API_Server SHALL reject the registration or password change request with a descriptive validation error.

### Requirement 2: Project Management

**User Story:** As a user, I want to create, organize, and manage projects associated with website Pages, so that I can structure my feedback work by site.

#### Acceptance Criteria

1. WHEN a user clicks the "Create Project" button and submits a project name and one or more URLs, THE Dashboard SHALL create a new Project with Active status and create a Page row for each submitted URL.
2. THE Dashboard SHALL display the project list in a left sidebar with separate Active and Archived tabs.
3. WHEN a user types in the project search field, THE Dashboard SHALL filter the project list to show only Projects whose names contain the search text as a case-insensitive substring.
4. WHEN a user selects "Rename project" from the project context menu, THE Dashboard SHALL allow the user to edit the Project name and persist the change.
5. WHEN a user selects "Archive project" from the project context menu, THE Dashboard SHALL move the Project to the Archived tab and set its status to Archived.
6. WHEN a user selects "Delete project" from the project context menu, THE Dashboard SHALL prompt for confirmation and, upon confirmation, permanently remove the Project, its Pages, and all associated Annotations.
7. WHEN a user selects "Project details" from the project context menu, THE Dashboard SHALL display the Project metadata including creation date, associated Page URLs, annotation count, and team members.
8. WHEN a user selects "Copy project link" from the project context menu, THE Dashboard SHALL copy the shareable Project URL to the clipboard and display a confirmation toast.
9. WHEN a user selects "Open in Pinpoint app" from the project context menu, THE Dashboard SHALL open the Project in the main application view.

### Requirement 3: Annotation Creation via Chrome Extension

**User Story:** As a user, I want to click on any element on a live website and leave feedback, so that I can provide contextual annotations without taking screenshots.

#### Acceptance Criteria

1. WHEN the Extension is enabled and a user clicks on a DOM element, THE Extension SHALL display the Popover anchored to the clicked element with tabs for Note, Suggestion, and Guideline.
2. WHEN a user selects a tab in the Popover and enters non-empty text, THE Extension SHALL enable the Submit button.
3. WHEN a user types "@" followed by characters in the Popover text field, THE Extension SHALL display a dropdown list of matching team Members for mention selection.
4. WHEN a user clicks Submit on the Popover, THE Extension SHALL create an Annotation linked to the target DOM element, request a unique pin number from the API_Server, and persist the Annotation via the API_Server.
5. WHEN a user clicks Cancel on the Popover, THE Extension SHALL close the Popover without creating an Annotation.
6. THE Extension SHALL display an Annotation_Pin as a numbered badge at the position of each Annotation on the page.
7. WHEN a user clicks on an existing Annotation_Pin, THE Extension SHALL open the Popover displaying the Annotation details and any associated comments.

### Requirement 4: Annotation Severity and Classification

**User Story:** As a user, I want to assign color-coded severities to my annotations, so that I can prioritize feedback by importance.

#### Acceptance Criteria

1. WHEN a user creates or edits an Annotation, THE Popover SHALL display a Severity selector with options for Critical, Major, Minor, and Informational.
2. THE Extension SHALL render each Annotation_Pin with the background color obtained from the Severity_Colors map for the Annotation's Severity.
3. WHEN no Severity is explicitly selected, THE Extension SHALL assign the default Severity of Informational to the Annotation.

### Requirement 5: Chrome Extension Overlay and Toolbar

**User Story:** As a user, I want a toggle to enable or disable the annotation overlay and a floating toolbar for quick actions, so that I can control when I am in feedback mode.

#### Acceptance Criteria

1. WHEN a user clicks the Pinpoint Extension icon in the Chrome toolbar, THE Extension SHALL toggle the annotation overlay on or off for the current tab.
2. WHILE the Extension overlay is enabled, THE Extension SHALL display the Floating_Toolbar anchored to the bottom center of the viewport.
3. THE Floating_Toolbar SHALL contain buttons for close, user avatar, share, and link.
4. WHEN a user clicks the close button on the Floating_Toolbar, THE Extension SHALL disable the overlay and hide the Floating_Toolbar.
5. WHEN a user clicks the share button on the Floating_Toolbar, THE Extension SHALL display a share dialog allowing the user to invite Members by email or copy a shareable link.
6. WHEN a user clicks the link button on the Floating_Toolbar, THE Extension SHALL copy the current page URL with the Project context to the clipboard.
7. WHILE the Extension overlay is enabled, THE Extension SHALL display the Sidebar_Panel with tabs for Active and Resolved Annotations.

### Requirement 6: Real-Time Collaboration

**User Story:** As a team member, I want to see annotations, comments, and co-viewer presence from other team members in real time, so that I can collaborate without refreshing the page.

#### Acceptance Criteria

1. WHEN a Member creates a new Annotation, THE Collaboration_Service SHALL broadcast the Annotation to all connected Members viewing the same Project within 2 seconds.
2. WHEN a Member adds a comment to an Annotation, THE Collaboration_Service SHALL broadcast the comment to all connected Members viewing the same Project within 2 seconds.
3. WHEN a Member resolves or reopens an Annotation, THE Collaboration_Service SHALL update the Annotation status for all connected Members within 2 seconds.
4. WHILE a Member is connected to a Project, THE Collaboration_Service SHALL maintain a WebSocket connection and automatically reconnect within 5 seconds if the connection is lost.
5. WHEN a new Annotation_Pin appears via real-time update, THE Extension SHALL render the Annotation_Pin on the page without requiring a page refresh.
6. WHEN a Member opens an Annotation in the Extension that is already open by another Member, THE Collaboration_Service SHALL broadcast a presence indicator listing the co-viewers to all connected Members of the same Project.
7. WHEN a Member closes an Annotation that the Member previously had open, THE Collaboration_Service SHALL broadcast a presence update removing the Member from that Annotation's co-viewer list.

### Requirement 7: Heuristic Evaluation

**User Story:** As a UX researcher, I want to conduct heuristic evaluations using standard or custom guidelines, so that I can perform structured usability audits.

#### Acceptance Criteria

1. THE Dashboard SHALL provide a default set of Nielsen's 10 Heuristics as predefined Guidelines.
2. WHEN a user navigates to the Guidelines tab in Settings, THE Dashboard SHALL display all available Guidelines (predefined and custom) in a list.
3. WHEN a user creates a custom Guideline by providing a name and description, THE Dashboard SHALL persist the Guideline and make it available for selection during Heuristic_Evaluations.
4. WHEN a user starts a Heuristic_Evaluation on a Project, THE Dashboard SHALL allow the user to select which Guidelines to apply.
5. WHEN a user selects the Guideline tab in the Popover, THE Extension SHALL display the list of selected Guidelines for the current Heuristic_Evaluation, allowing the user to associate the Annotation with a specific Guideline.
6. THE Dashboard SHALL allow creation of unlimited custom Guidelines.

### Requirement 8: Bug Reporting

**User Story:** As a QA engineer, I want to leave detailed bug reports directly on website elements with environment context, so that I can streamline the bug reporting process.

#### Acceptance Criteria

1. WHEN a user creates an Annotation of type Note with Severity Critical or Major, THE Extension SHALL tag the Annotation as a bug report.
2. WHEN a user views a bug report Annotation, THE Popover SHALL display the captured Environment_Metadata in a single-line summary (e.g., "Reported on Chrome 124 on macOS 14.5") and provide an expandable details section with the full Environment_Metadata.
3. WHEN a user views a bug report Annotation in the Dashboard annotation detail view, THE Dashboard SHALL display the captured Environment_Metadata in the same single-line summary form and provide the same expandable details section.
4. THE Dashboard SHALL allow assigning a Member and a due date to a bug report Annotation, where the Member is selected from a dropdown of the Project's team members fetched via `GET /api/v1/projects/:id/members`.

### Requirement 9: Team Management

**User Story:** As a project owner, I want to create teams, invite members, and assign roles, so that I can control access to my projects.

#### Acceptance Criteria

1. WHEN a user creates a new Team by providing a team name, THE Dashboard SHALL create the Team and assign the creating user as the Owner.
2. WHEN an Owner invites a new Member by email, THE API_Server SHALL send an invitation email and, upon acceptance, add the Member to the Team with the Viewer role.
3. WHEN an Owner or Admin changes a Member's role, THE Dashboard SHALL update the Member's role and persist the change.
4. THE Dashboard SHALL enforce role-based access: Owners can manage all settings and Members; Admins can manage Projects and Annotations; Viewers can view Projects and add Annotations.
5. WHEN an Owner removes a Member from a Team, THE Dashboard SHALL revoke the Member's access to all Team Projects and display a confirmation message.
6. IF a user attempts an action exceeding the permissions of the user's role, THEN THE API_Server SHALL reject the request and return a 403 authorization error.

### Requirement 10: Notification Preferences

**User Story:** As a user, I want to configure which email notifications I receive, so that I can control the volume of emails from Pinpoint.

#### Acceptance Criteria

1. WHEN a user navigates to the Notifications tab in Settings, THE Dashboard SHALL display email toggle switches for each notification type: "New annotation created on my project", "New comment added", "Got promoted to project owner", and "Project deleted by owner".
2. WHEN a user toggles a notification preference, THE Dashboard SHALL persist the updated preference immediately.
3. WHEN an event matching an enabled notification preference occurs, THE API_Server SHALL enqueue a notification to the Notification_Queue for delivery within 60 seconds.
4. WHEN an event matching a disabled notification preference occurs, THE API_Server SHALL not enqueue a notification for that user.

### Requirement 11: Export Reports

**User Story:** As a project manager, I want to export project findings into PDF or CSV format, so that I can share feedback reports with stakeholders who do not use Pinpoint.

#### Acceptance Criteria

1. WHEN a user selects "Export project" from the project context menu, THE Dashboard SHALL generate a Report containing all Annotations, their severities, types, comments, and associated metadata.
2. THE Report SHALL include the Project name, associated Page URLs, export date, and a summary of Annotation counts grouped by Severity.
3. THE Report SHALL list each Annotation with its type, Severity, text content, author, creation date, Browser_Family, browser version, OS_Family, OS version, Device_Type, and associated Guideline (if applicable).
4. THE Dashboard SHALL offer both PDF and CSV export formats; the CSV format SHALL include columns for Browser_Family, browser version, OS_Family, OS version, and Device_Type.
5. WHEN the Report generation is complete, THE Dashboard SHALL provide a download link and display a success notification.

### Requirement 12: Annotation Comment Threads

**User Story:** As a team member, I want to add comments to existing annotations and @mention colleagues, so that I can have contextual discussions about specific feedback items.

#### Acceptance Criteria

1. WHEN a user opens an existing Annotation, THE Popover SHALL display a comment thread showing all previous comments in chronological order.
2. WHEN a user submits a new comment on an Annotation, THE API_Server SHALL persist the comment and associate it with the Annotation.
3. WHEN a user types "@" followed by characters in the comment field, THE Popover SHALL display a dropdown of matching team Members for mention selection.
4. WHEN a comment containing a Mention is submitted, THE API_Server SHALL create a notification for the mentioned Member according to the Member's Notification_Preferences.
5. WHEN a user resolves an Annotation, THE Extension SHALL move the Annotation from the Active tab to the Resolved tab in the Sidebar_Panel.
6. WHEN a user reopens a resolved Annotation, THE Extension SHALL move the Annotation from the Resolved tab back to the Active tab in the Sidebar_Panel.

### Requirement 13: Annotation Data Serialization

**User Story:** As a developer, I want Annotation data to be reliably serialized and deserialized between the Extension, Dashboard, and API_Server, so that no feedback data is lost during transmission.

#### Acceptance Criteria

1. THE API_Server SHALL serialize Annotation objects to JSON format for transmission to the Extension and Dashboard.
2. THE Extension SHALL deserialize JSON Annotation payloads into Annotation objects for rendering.
3. FOR ALL valid Annotation objects, serializing the Annotation to JSON and then deserializing the JSON back SHALL produce an Annotation object equivalent to the original (round-trip property).
4. IF the Extension receives a malformed JSON payload, THEN THE Extension SHALL log the error via the Structured_Logger pattern and display a user-friendly error message without crashing.
5. IF the API_Server receives a malformed Annotation request body, THEN THE API_Server SHALL return a 400 Bad Request response with a descriptive validation error message.

### Requirement 14: DOM Element Targeting and Persistence

**User Story:** As a user, I want my annotations to remain attached to the correct elements even after page reloads or layout changes, so that my feedback stays contextually accurate.

#### Acceptance Criteria

1. WHEN a user creates an Annotation on a DOM element, THE Extension SHALL compute and store a CSS selector path and an XPath for the target element.
2. WHEN the Extension loads Annotations for a page, THE Extension SHALL resolve each Annotation's stored selector to locate the target DOM element and position the Annotation_Pin at the resolved element's current bounding-box position.
3. IF the Extension cannot resolve a stored selector to a DOM element, THEN THE Extension SHALL display the Annotation_Pin at the stored page coordinates (`pageX`, `pageY`) as a last-resort visual hint and show a warning indicator that the target element was not found.
4. FOR ALL DOM elements that have a unique CSS selector, storing the selector then resolving the selector on the same page SHALL return the original DOM element (round-trip property).
5. WHILE Annotations are displayed on a page, THE Extension SHALL maintain a MutationObserver and a ResizeObserver scoped to the document and SHALL recompute every visible Annotation_Pin's screen coordinates from its resolved element's current bounding box on each observed mutation, on `window` resize, and on document scroll.
6. THE Extension SHALL treat the stored `pageX` and `pageY` values only as a fallback used when selector resolution fails, and SHALL not use stored coordinates as the primary source of pin position when the resolved element is available.

### Requirement 15: Password-Protected Shared Links

**User Story:** As a project owner, I want to share project links that require a password and are protected against brute-force guessing, so that I can control who can view my feedback.

#### Acceptance Criteria

1. THE Dashboard SHALL allow the user to set a password on a shared Project link.
2. WHEN a visitor opens a password-protected Project link, THE Dashboard SHALL display a password prompt before granting access.
3. WHEN a visitor enters the correct password during a non-locked period, THE Dashboard SHALL grant read-only access to the Project AND THE API_Server SHALL reset the link's `failed_attempts` counter to zero.
4. IF a visitor enters an incorrect password three consecutive times within a non-locked period, THEN THE API_Server SHALL set the link's `locked_until` timestamp to 15 minutes in the future and the Dashboard SHALL display a Shared_Link_Lock message.
5. WHILE a Shared_Link_Lock is active (the current time is before `locked_until`), THE API_Server SHALL reject all password attempts with a 423 response and a `Retry-After` header.
6. WHEN a visitor submits a password attempt after `locked_until` has passed, THE API_Server SHALL reset `failed_attempts` to zero before evaluating the submitted password.

### Requirement 16: Project Analytics and Kanban View

**User Story:** As a project manager, I want to view annotation analytics and organize feedback in a Kanban board, so that I can track progress and prioritize work.

#### Acceptance Criteria

1. THE Dashboard SHALL display a project analytics view showing Annotation counts grouped by Severity, type, status, and Browser_Family.
2. THE Dashboard SHALL provide a Kanban view with columns labeled using the Status_Labels map for `active`, `in_progress`, and `resolved`.
3. WHEN a user drags an Annotation card between Kanban columns, THE Dashboard SHALL update the Annotation status and persist the change via the API_Server.
4. THE Dashboard SHALL update the analytics view in real time as Annotations are created, modified, or resolved.
5. FOR ALL analytics dimensions (Severity, type, status, Browser_Family), the sum of Annotation counts across the dimension's groups SHALL equal the total Annotation count for the Project.

### Requirement 17: Browser and Operating System Detection on Annotations

**User Story:** As a QA engineer or product owner, I want every Annotation to carry the browser and operating system the reporter was using, so that I can reproduce issues and analyze defect distribution by environment.

#### Acceptance Criteria

1. WHEN a user submits an Annotation of any type from the Extension, THE Extension SHALL run the User_Agent_Parser against `navigator.userAgent` and SHALL include in the create-Annotation request the resulting Browser_Family, browser version, OS_Family, OS version, Device_Type, and the raw `navigator.userAgent` string.
2. WHERE the User_Agent_Parser cannot match a Browser_Family or OS_Family, THE Extension SHALL set the corresponding family field to the literal string `unknown`, SHALL set the corresponding version field to `null`, AND SHALL still send the raw User-Agent string.
3. WHEN the API_Server persists an Annotation, THE API_Server SHALL store the Environment_Metadata on the Annotation row, regardless of the Annotation's type or severity.
4. WHEN a Member views any Annotation in the Popover or in the Dashboard annotation detail view, THE Dashboard and THE Extension SHALL display the captured Browser_Family, browser version, OS_Family, OS version, and Device_Type.
5. THE Dashboard analytics view SHALL include a "By Browser" breakdown that groups Annotations by Browser_Family alongside the existing Severity, type, and status breakdowns.

### Requirement 18: Authentication Storage and CSRF Protection

**User Story:** As a security-conscious user, I want my Dashboard session to be protected from XSS-driven token theft and from cross-site state-changing requests, so that compromise of one tab cannot impersonate me.

#### Acceptance Criteria

1. THE API_Server SHALL issue Dashboard sessions exclusively via a Session_Cookie with the `httpOnly`, `Secure`, and `SameSite=Lax` attributes, AND SHALL not return Dashboard session tokens in any response body.
2. THE Dashboard SHALL not write authentication tokens to `window.localStorage` or `window.sessionStorage`.
3. WHEN the API_Server issues a Session_Cookie, THE API_Server SHALL also issue a separate, readable, non-httpOnly CSRF_Token cookie scoped to the same site.
4. WHEN the Dashboard issues a `POST`, `PUT`, `PATCH`, or `DELETE` request to the API_Server, THE Dashboard SHALL include the CSRF_Token value as a request header (e.g., `X-CSRF-Token`).
5. IF a `POST`, `PUT`, `PATCH`, or `DELETE` request to the API_Server arrives without a header value matching the CSRF_Token cookie, THEN THE API_Server SHALL reject the request with a 403 response.
6. THE Extension SHALL store its Bearer_Token in `chrome.storage.local` and SHALL send the Bearer_Token in the `Authorization: Bearer` header for REST calls and as the auth payload for WebSocket connections.
7. THE Extension SHALL not authenticate to the API_Server using the Session_Cookie or the CSRF_Token cookie.

### Requirement 19: Authentication Rate Limiting

**User Story:** As an administrator, I want strict rate limiting on authentication-sensitive endpoints, so that brute-force credential and password attacks are infeasible.

#### Acceptance Criteria

1. THE API_Server SHALL enforce a per-IP rate limit of at most 10 requests per 15-minute window on each of the following endpoints: login, register, password-reset request, and shared-link verify.
2. IF the per-IP rate limit on an authentication endpoint is exceeded, THEN THE API_Server SHALL reject further requests from that IP for that endpoint with a 429 response and a `Retry-After` header indicating the seconds until the window resets.
3. THE per-IP authentication rate limit SHALL be strictly tighter than the API_Server's general-traffic rate limit.

### Requirement 20: Email Verification on Registration

**User Story:** As an administrator, I want new accounts to verify their email address before they can use the system, so that disposable or typo'd addresses cannot acquire authenticated sessions.

#### Acceptance Criteria

1. WHEN a user submits a valid registration request, THE API_Server SHALL create the user record with a `verified=false` flag, generate a single-use Email_Verification token with a maximum lifetime of 24 hours, store the token's hash, and send the verification link to the submitted email address.
2. WHEN a user opens a valid, unexpired Email_Verification link, THE API_Server SHALL set the user's `verified` flag to true, mark the token as used, AND THE Dashboard SHALL display a success page inviting the user to log in.
3. IF a user opens an Email_Verification link whose token is expired, has been used, or does not match a stored hash, THEN THE Dashboard SHALL display an error page and the API_Server SHALL not change the user's `verified` flag.
4. WHILE a user has `verified=false`, THE API_Server SHALL refuse all login attempts for that user, returning an error response indicating that email verification is required, and SHALL not issue a Session_Cookie or Bearer_Token.

### Requirement 21: Production JWT Secret Hardening

**User Story:** As an operator, I want the API_Server to refuse to start with insecure default JWT secrets in production, so that an accidental deployment cannot ship with a known-bad signing key.

#### Acceptance Criteria

1. WHILE `NODE_ENV` equals `production`, IF the `JWT_SECRET` environment variable is unset, empty, or equal to any of `dev-secret`, `dev-secret-change-in-production`, or `change-me`, THEN THE API_Server SHALL log a fatal error via the Structured_Logger and exit with a non-zero status code before binding to its listening port.
2. WHILE `NODE_ENV` does not equal `production`, THE API_Server SHALL be permitted to start with any non-empty `JWT_SECRET` value.

### Requirement 22: Project URL-to-Project Resolution and Member Listing

**User Story:** As an Extension user, I want the Extension to recognize which Project I am annotating based on the current page URL and to know who is on that Project's team, so that mention autocomplete and assignee pickers work without manual project selection.

#### Acceptance Criteria

1. THE API_Server SHALL expose `GET /api/v1/projects/by-url?url=<encoded_url>` which returns the Project containing a Page whose URL matches the supplied URL and which the authenticated user can access.
2. IF no accessible Project has a Page matching the supplied URL, THEN THE API_Server SHALL respond to `GET /api/v1/projects/by-url` with a 404 response.
3. WHEN the Extension overlay is enabled on a host page, THE Extension SHALL call `GET /api/v1/projects/by-url` with the current page URL to determine the active Project AND SHALL not connect to the Collaboration_Service when no matching Project is returned.
4. THE API_Server SHALL expose `GET /api/v1/projects/:id/members` which returns the Project's team members (id, name, email, avatar URL, role).
5. WHEN the Extension determines an active Project, THE Extension SHALL call `GET /api/v1/projects/:id/members` and SHALL use the returned list to populate the MentionAutocomplete and any assignee picker.
6. WHEN a Member opens a Project view in the Dashboard, THE Dashboard SHALL call `GET /api/v1/projects/:id/members` and SHALL use the returned list as the options for the assignee selector, replacing any free-text input.

### Requirement 23: Page Entity and Project-Page Lifecycle

**User Story:** As a developer, I want Pages to be a first-class entity that Annotations reference by id, so that the data model matches the multi-page Project reality and page deletion is well defined.

#### Acceptance Criteria

1. THE database schema SHALL contain a `pages` table with columns `id`, `project_id`, `url`, `title`, and `created_at`, where `(project_id, url)` is unique.
2. THE `annotations` table SHALL contain a `page_id` foreign key column referencing `pages.id`, AND every Annotation SHALL be associated with exactly one Page.
3. THE schema migration SHALL, for every existing Annotation that currently stores a `pageUrl` string, create or reuse a Page row with that URL within the Annotation's Project AND set the Annotation's `page_id` to that Page's id before the legacy `pageUrl` column is dropped or made nullable.
4. WHEN a request is sent to `DELETE /api/v1/projects/:id/pages/:pageId?onNonEmpty=cascade`, THE API_Server SHALL delete the Page and cascade-delete all Annotations whose `page_id` matches the Page id.
5. WHEN a request is sent to `DELETE /api/v1/projects/:id/pages/:pageId?onNonEmpty=block` (the default), THE API_Server SHALL refuse to delete the Page if any Annotation references it, returning a 409 response naming the count of associated Annotations.

### Requirement 24: Race-Condition-Free Pin Numbering

**User Story:** As a Project owner, I want every Annotation in a Project to have a unique pin number even when many users create annotations at the same instant, so that pins can be referenced unambiguously.

#### Acceptance Criteria

1. WHEN the API_Server creates an Annotation in a Project, THE API_Server SHALL assign the Annotation a `pinNumber` obtained from the Project_Pin_Sequence atomically with the insert.
2. FOR ALL pairs of Annotations within the same Project, the two Annotations SHALL have distinct `pinNumber` values, even when the create requests are received concurrently.
3. THE Project_Pin_Sequence implementation SHALL use either a per-Project Postgres sequence or an `UPDATE projects SET pin_counter = pin_counter + 1 WHERE id = $1 RETURNING pin_counter` pattern within the same transaction as the Annotation insert.

### Requirement 25: API Versioning

**User Story:** As an API consumer, I want all endpoints under a single versioned prefix and clear handling of legacy paths, so that future breaking changes can be rolled out without ambiguity.

#### Acceptance Criteria

1. THE API_Server SHALL serve all current endpoints under the API_Version_Prefix `/api/v1/`.
2. WHEN the API_Server receives a request whose path begins with `/api/` but not with `/api/v1/`, THE API_Server SHALL respond with a 410 Gone status, a JSON body of the form `{ "error": { "code": "API_VERSION_REMOVED", "message": "...", "newPath": "/api/v1<remainder>" } }`, AND SHALL not execute any handler for the legacy path.
3. THE Dashboard SHALL issue all API requests using the API_Version_Prefix.
4. THE Extension SHALL issue all API requests using the API_Version_Prefix.

### Requirement 26: Shared Color Palette and Status Labels

**User Story:** As a developer, I want a single source of truth for severity colors and status labels, so that the Extension and the Dashboard can never drift in look or wording.

#### Acceptance Criteria

1. THE shared library SHALL export a `SEVERITY_COLORS` map from each Severity value to a hex color string AND a `STATUS_LABELS` map from each annotation status value to a human-readable label.
2. THE Extension SHALL consume the `SEVERITY_COLORS` and `STATUS_LABELS` maps from the shared library AND SHALL not declare or maintain its own severity-color or status-label mappings.
3. THE Dashboard SHALL consume the `SEVERITY_COLORS` and `STATUS_LABELS` maps from the shared library AND SHALL not declare or maintain its own severity-color or status-label mappings.

### Requirement 27: Structured Logging

**User Story:** As an operator, I want machine-parseable JSON logs from the API_Server with consistent fields for correlation, so that I can search and aggregate logs across requests and errors.

#### Acceptance Criteria

1. THE API_Server SHALL use a single Structured_Logger (such as `pino`) for all log output AND SHALL not call `console.log`, `console.warn`, or `console.error` from request-handling code.
2. WHEN the API_Server completes any HTTP request, THE Structured_Logger SHALL emit one JSON log record containing the fields `request_id`, `method`, `path`, `status`, `latency_ms`, AND, when the request was authenticated, `user_id`.
3. WHEN the API_Server logs an error, THE Structured_Logger SHALL emit a JSON log record containing the fields `request_id` (when available), `error.code`, `error.message`, AND `error.stack`.
4. THE API_Server SHALL generate or accept a `request_id` per request and SHALL include it in every log record produced while handling that request.

### Requirement 28: Durable Notification Queue

**User Story:** As a user, I want notifications to survive server restarts and to retry transient send failures, so that I do not lose mentions or annotation alerts when something goes wrong.

#### Acceptance Criteria

1. THE database schema SHALL contain a `notifications` table with columns `id`, `status` (one of `pending`, `sent`, `failed`), `attempts`, `payload` (JSONB), `scheduled_at`, `last_error`, `created_at`, and `updated_at`.
2. WHEN the API_Server enqueues a notification, THE API_Server SHALL insert a row into the `notifications` table with `status='pending'`, `attempts=0`, the event payload, and a `scheduled_at` timestamp.
3. WHILE the API_Server is running, THE Notification_Queue worker SHALL select `pending` notifications whose `scheduled_at` is in the past and attempt to send them.
4. WHEN a send attempt succeeds, THE Notification_Queue SHALL set the row's `status` to `sent` and increment `attempts`.
5. IF a send attempt fails AND `attempts` is less than 5, THEN THE Notification_Queue SHALL leave `status` as `pending`, increment `attempts`, set `scheduled_at` to a value computed by exponential backoff (for example `now() + 2^attempts minutes`), AND store the error message in `last_error`.
6. IF a send attempt fails AND `attempts` reaches 5, THEN THE Notification_Queue SHALL set `status` to `failed` and stop retrying.
7. WHEN the API_Server starts, THE API_Server SHALL re-process all notifications with `status='pending'` whose `scheduled_at` is in the past.

### Requirement 29: Containerized Development Setup

**User Story:** As a contributor, I want to start the entire development stack with one command, so that I do not need to install or configure Postgres or each service individually.

#### Acceptance Criteria

1. THE repository SHALL contain a `docker-compose.yml` at its root that defines services for Postgres, the API_Server, and the Dashboard.
2. WHEN a contributor runs `docker compose up` in the repository root, THE compose stack SHALL start the Postgres service, run all pending database migrations against it, and start the API_Server and Dashboard so that the Dashboard is reachable from the host.
3. THE API_Server service in `docker-compose.yml` SHALL run database migrations on startup before accepting requests.

### Requirement 30: Continuous Integration

**User Story:** As a maintainer, I want every pull request to be automatically validated, so that broken or untested code cannot be merged unnoticed.

#### Acceptance Criteria

1. THE repository SHALL contain a GitHub Actions workflow that runs on every pull request targeting the default branch.
2. WHEN the GitHub Actions workflow runs, THE workflow SHALL execute lint, type-check, unit tests, and property-based tests across the shared library, API_Server, Dashboard, and Extension packages.
3. IF any of lint, type-check, unit tests, or property-based tests fails, THEN THE GitHub Actions workflow SHALL exit with a non-zero status and report failure on the pull request.

### Requirement 31: UI Implementation Without React

**User Story:** As an architect, I want the Dashboard and Extension UI to be implemented without a virtual-DOM React or Preact runtime, so that we ship smaller bundles, retain full control over the DOM, and remove a non-essential dependency.

#### Acceptance Criteria

1. THE Dashboard SHALL be implemented in TypeScript using native HTML, CSS modules, and the platform DOM API; no virtual-DOM runtime (including but not limited to React, Preact, and `htm`-tagged Preact) SHALL be present in the shipped Dashboard bundle.
2. THE Extension SHALL be implemented in TypeScript using Web_Components (Custom Elements with Shadow DOM where appropriate); no virtual-DOM runtime (including but not limited to React, Preact, and `htm`-tagged Preact) SHALL be present in the shipped Extension bundle.
3. THE Extension SHALL implement each of the following UI pieces as a distinct Custom Element: `FloatingToolbar`, `Popover`, `SidebarPanel`, `AnnotationPin`, `MentionAutocomplete`, and `CommentThread`.
4. THE Extension content script SHALL continue to use Shadow DOM for style isolation between Pinpoint UI and the host page.
5. FOR every user-visible feature already implemented in React in the Dashboard or Extension, the migrated implementation SHALL preserve the same user-visible behavior, the same form fields, the same wording, and the same severity and status colors and labels (drawn from the `SEVERITY_COLORS` and `STATUS_LABELS` maps).

### Requirement 32: Extension Installability and Build Pipeline

**User Story:** As a developer or end user, I want to install the Pinpoint Chrome Extension cleanly, so that I can begin using it without manual file shuffling.

#### Acceptance Criteria

1. THE Extension SHALL be bundled by a Manifest V3-aware bundler such as CRXJS-Vite or @samrum/vite-plugin-web-extension that produces a `dist/` directory loadable directly via Chrome's "Load unpacked" without further manual steps.
2. THE Extension repository SHALL include `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png` referenced by `manifest.json`.
3. THE Extension `manifest.json` SHALL replace the broad `<all_urls>` content-script match with explicit `host_permissions` declared per the deployment target AND SHALL include `activeTab` and `scripting`.

### Requirement 33: Extension Authentication UI and Token Refresh

**User Story:** As an Extension user, I want to log in and out from inside the Extension and have my session refresh transparently, so that I am never silently signed out mid-session.

#### Acceptance Criteria

1. THE Extension SHALL provide an in-extension login surface (popup or full-tab page) that accepts email and password, submits to `/api/v1/auth/login`, and stores the returned Bearer_Token in `chrome.storage.local`.
2. THE Extension SHALL provide an in-extension logout surface that calls `POST /api/v1/auth/logout`, clears the stored Bearer_Token, and reverts the overlay to a logged-out state.
3. THE API_Server SHALL expose `POST /api/v1/auth/refresh` which accepts a valid or recently-expired-within-grace-window Bearer_Token and returns a freshly minted Bearer_Token.
4. WHILE the Extension overlay is enabled and a stored Bearer_Token is within 5 minutes of expiration, THE Extension SHALL call `/auth/refresh` and replace the stored token before the next API call.
5. IF a stored Bearer_Token is rejected with 401 by any API call, THEN THE Extension SHALL clear the stored token and show the in-extension login surface.

### Requirement 34: Screenshot Capture on Annotation

**User Story:** As a reporter, I want a screenshot of what I see attached to every annotation, so that viewers can see exactly what I saw without me explaining.

#### Acceptance Criteria

1. WHEN a user submits an Annotation from the Extension, THE Extension SHALL request a screenshot of the visible viewport from the service worker via `chrome.tabs.captureVisibleTab` and attach the resulting PNG to the create-Annotation request.
2. THE Extension SHALL allow the user to disable screenshot attachment per-annotation via a toggle in the Popover.
3. THE API_Server SHALL persist the screenshot to S3-compatible object storage and store the resulting object key on the Annotation row.
4. WHEN a Member views an Annotation that has a screenshot, THE Extension and Dashboard SHALL display the screenshot inline in the annotation detail view.
5. THE Report (PDF and CSV) SHALL include the screenshot URL or embedded image where available.

### Requirement 35: Screenshot Markup

**User Story:** As a reporter, I want to draw arrows and boxes and blur sensitive regions on the captured screenshot, so that my point comes across at a glance.

#### Acceptance Criteria

1. WHILE composing an Annotation in the Extension, THE Popover SHALL provide a markup editor over the captured screenshot allowing the user to draw rectangles, arrows, freehand strokes, and pixelate regions.
2. THE Extension SHALL persist the user's markup as a Markup_Document JSON associated with the screenshot AND SHALL render the markup composited with the screenshot when the Annotation is viewed.
3. THE markup editor SHALL provide an "undo" action that reverses the last markup operation.

### Requirement 36: Console and Network Capture for Bug Reports

**User Story:** As a QA engineer, I want recent console errors and network calls attached to bug reports automatically, so that engineers can debug without me re-pasting logs.

#### Acceptance Criteria

1. WHILE the Extension overlay is enabled, THE Extension SHALL maintain a rolling Capture_Buffer of the most recent 50 console messages (log, warn, error) and the most recent 50 Resource Timing entries from `performance.getEntriesByType('resource')`.
2. WHEN a user submits a bug-report Annotation (type=note AND severity in {Critical, Major}), THE Extension SHALL attach the captured console and network buffers to the create-Annotation request.
3. WHEN a Member views a bug-report Annotation that has captured console or network data, THE Extension and Dashboard SHALL display the captured data in collapsible sections of the annotation detail view.
4. THE Extension SHALL allow the user to disable console and network capture globally via a setting in the extension options page.

### Requirement 37: Element-Hover Preview

**User Story:** As an annotator, I want to see which element I'm about to click before I click it, so that I don't pin to the wrong target.

#### Acceptance Criteria

1. WHILE the Extension overlay is enabled and the user has not yet clicked, THE Extension SHALL render a non-intrusive outline around the DOM element currently under the pointer to indicate the click target.
2. THE outline SHALL update at no greater than 60 frames per second AND SHALL not interfere with the host page's pointer events.
3. WHEN a user opens the Popover by clicking, THE Extension SHALL hide the hover outline.

### Requirement 38: SPA Navigation Handling

**User Story:** As a user of single-page applications, I want the Extension to recognize when the URL changes without a full reload, so that I can keep annotating across views.

#### Acceptance Criteria

1. WHEN the host page changes URL via `history.pushState`, `history.replaceState`, or `popstate`, THE Extension SHALL re-resolve the active Project via `GET /api/v1/projects/by-url`, refresh the Sidebar_Panel and Annotation_Pin list to match the new URL, AND join the new Project's collaboration room.
2. IF the new URL has no matching Project, THEN THE Extension SHALL show the project picker fallback defined in Requirement 39 instead of disabling itself silently.

### Requirement 39: Manual Project Picker Fallback

**User Story:** As a user, I want to manually pick a project when the Extension can't auto-detect one, so that I am never blocked from annotating.

#### Acceptance Criteria

1. WHEN `GET /api/v1/projects/by-url` returns 404, THE Extension SHALL display a project picker dropdown listing the user's accessible Projects ordered by last access AND SHALL allow the user to manually select an active Project for the current page.
2. WHEN a user manually selects a Project from the picker, THE Extension SHALL persist the URL→Project mapping in `chrome.storage.local` so subsequent visits to the same URL skip the picker.

### Requirement 40: Keyboard Shortcuts

**User Story:** As a power user, I want keyboard shortcuts to drive the Extension, so that I can annotate quickly without reaching for the mouse.

#### Acceptance Criteria

1. THE Extension SHALL register the following commands via `chrome.commands`: toggle the overlay (default `Alt+Shift+F`); open or close the Sidebar_Panel (default `Alt+Shift+S`); jump to the next Annotation_Pin on the page (default `Alt+]`); jump to the previous Annotation_Pin on the page (default `Alt+[`).
2. THE user SHALL be able to remap each command via Chrome's `chrome://extensions/shortcuts` page.

### Requirement 41: Draft Persistence

**User Story:** As a user, I want my in-progress annotation to survive accidental popover dismissal or tab reload, so that I never lose what I have typed.

#### Acceptance Criteria

1. WHILE a user is composing an Annotation in the Popover, THE Extension SHALL persist the in-progress draft (body text, severity, type, target) to `chrome.storage.session` keyed by the page URL on every input event.
2. WHEN the Popover is reopened on the same URL after dismissal or tab reload, THE Extension SHALL prefill the Popover with the persisted draft.
3. WHEN a draft is successfully submitted, THE Extension SHALL delete the persisted draft for that URL.

### Requirement 42: Extension Accessibility

**User Story:** As a keyboard or screen-reader user, I want the Extension overlay to be fully accessible, so that I can annotate without a mouse and with assistive technology.

#### Acceptance Criteria

1. THE Extension overlay UI (Floating_Toolbar, Popover, Sidebar_Panel, MentionAutocomplete, CommentThread, Pin) SHALL apply correct ARIA roles, labels, and keyboard semantics: `role="dialog"` and a focus trap on Popover, `role="toolbar"` on Floating_Toolbar, `role="listbox"` and arrow-key navigation on MentionAutocomplete and Sidebar_Panel.
2. THE Extension SHALL allow the user to dismiss any overlay component (Popover, Sidebar_Panel) using the `Escape` key.
3. THE Extension SHALL keep keyboard focus inside the Popover while it is open AND SHALL restore focus to the previously-focused element when the Popover is dismissed.

### Requirement 43: Dark Mode

**User Story:** As a user with a dark OS or browser theme, I want the Extension overlay to match, so that it does not blast my eyes at night.

#### Acceptance Criteria

1. THE Extension overlay UI SHALL respond to the user's `prefers-color-scheme` media query AND SHALL render in a dark color palette when the user's OS or browser preference is dark.
2. THE Severity_Colors values SHALL remain stable across light and dark modes; only neutrals shift.

### Requirement 44: Offline Mode

**User Story:** As a user, I want to keep annotating when my internet drops, so that flaky networks do not cost me work.

#### Acceptance Criteria

1. WHILE the Extension is offline (`navigator.onLine === false` OR API and WebSocket calls are failing), THE Extension SHALL allow the user to create new Annotations and add Comments locally AND SHALL show a clear "Offline" banner in the overlay.
2. WHILE the Extension is offline, THE Extension SHALL queue every create-Annotation, update-Annotation, status-change, and create-Comment operation in `chrome.storage.local` with a client-generated UUID and a `pendingSync=true` flag.
3. WHEN the Extension regains connectivity, THE Extension SHALL replay the queued operations in original order against `/api/v1` AND SHALL replace each local UUID and any reference to it with the server-assigned id, including the server-issued `pinNumber`.
4. IF a queued operation fails on replay because the server rejects it (e.g., 403, 404, 409), THEN THE Extension SHALL retain the local copy in a Sync_Conflict_Tray AND SHALL allow the user to view the conflict reason and either retry, edit, or discard the local copy.
5. WHILE offline, THE Extension SHALL not allow operations that fundamentally require server state (e.g., resolving an Annotation that does not yet exist on the server) AND SHALL clearly disable those actions in the UI.
6. WHEN replaying a queued create-Annotation, THE Extension SHALL re-resolve the DOM target's selector against the live page AND SHALL flag the local pin with the resolved-element warning indicator if the selector no longer matches.

### Requirement 45: PII Auto-Redaction in Captures

**User Story:** As a privacy-conscious user, I want sensitive fields automatically blurred in captured screenshots, so that I do not accidentally leak passwords or card numbers.

#### Acceptance Criteria

1. WHEN the Extension captures a screenshot, THE Extension SHALL automatically blur or mask any DOM element that satisfies any of the following: `<input type="password">`, `<input>` whose `autocomplete` attribute matches `/^cc-/`, an element with the `data-fl-redact` attribute, or an element with `aria-label` matching the configured PII-label regex.
2. THE Extension SHALL allow site authors to opt elements in to redaction by adding a `data-fl-redact` attribute and to opt out using `data-fl-no-redact`.
3. THE Extension SHALL allow the user to manually paint over additional regions in the screenshot markup editor (Requirement 35).

### Requirement 46: Per-Site Allow/Block List

**User Story:** As a security-aware user, I want to disable the Extension on specific sites, so that internal tools and banking pages are never touched.

#### Acceptance Criteria

1. THE Extension options page SHALL provide an allow-list and a block-list of host patterns.
2. IF the current host matches the block-list, THEN THE Extension SHALL not inject the overlay nor any capture mechanisms on that page.
3. WHERE an allow-list is non-empty AND the current host does not match it, THE Extension SHALL not inject the overlay on that page.
4. THE allow-list and block-list SHALL each accept exact hosts and wildcard patterns (e.g., `*.bank.example.com`).

### Requirement 47: "What Gets Sent" Disclosure

**User Story:** As a user, I want to see exactly what data the Extension transmits when I submit an annotation, so that I can give informed consent.

#### Acceptance Criteria

1. WHEN a user opens the Popover for the first time on a host or after a settings change, THE Extension SHALL display a one-time disclosure listing every category of data that will be sent on submission: annotation body, screenshot, console buffer, network buffer, environment metadata, page URL, target selector.
2. THE disclosure SHALL provide a link to the Pinpoint privacy policy AND a button to open the Extension options page where capture toggles can be flipped.

### Requirement 48: Cross-Frame Support

**User Story:** As a user, I want to annotate elements that live inside iframes, so that pages built with embedded sub-applications are not partially uncoverable.

#### Acceptance Criteria

1. WHILE the Extension overlay is enabled, THE Extension content script SHALL execute in every same-origin frame on the page (`all_frames: true`) AND SHALL register a single shared overlay host in the top frame to prevent duplicate UI in nested frames.
2. THE Extension SHALL forward click events from sub-frames to the top-frame overlay host via `postMessage` so that DOM elements in iframes can be annotated.
3. THE Extension SHALL not attempt to inject the overlay into cross-origin frames.

### Requirement 49: CSP-Strict Resilience

**User Story:** As a user on security-hardened sites, I want the Extension overlay to keep working under strict Content Security Policy headers, so that my annotation experience is not silently broken.

#### Acceptance Criteria

1. THE Extension SHALL render its overlay UI without inline event handlers, inline `<style>` strings on host elements, or `eval`-class APIs so that the overlay continues to function on host pages with strict `Content-Security-Policy` headers.
2. THE Extension SHALL host all overlay styles inside Shadow DOM via a constructable stylesheet AND SHALL fall back to a static `<style>` element inside the Shadow Root when constructable stylesheets are unavailable.

### Requirement 50: Extension Error Boundaries

**User Story:** As a user, I want a bug in one piece of the overlay never to crash the host page or the rest of the overlay, so that my browsing remains stable.

#### Acceptance Criteria

1. WHEN any Extension UI component throws or rejects, THE Extension SHALL log the error via the structured-logger pattern, render a localized "Something went wrong" indicator inside the affected component, AND SHALL continue functioning in unaffected components.
2. THE Extension content script's outermost mount and unmount paths SHALL be wrapped in try/catch AND SHALL never propagate exceptions into the host page's runtime.

### Requirement 51: Mutation Observer Performance Budget

**User Story:** As a user on heavy single-page applications, I want the Extension's pin repositioning to remain responsive even when the page is busy, so that the Extension is not the reason my browser feels slow.

#### Acceptance Criteria

1. THE PinPositioner's MutationObserver SHALL coalesce all observed mutations within a single animation frame into one position recompute pass.
2. WHILE the host page emits more than 60 mutation events per second sustained over 5 seconds, THE PinPositioner SHALL automatically downgrade to a 250 ms throttled position recompute pass AND SHALL emit a structured-logger warning indicating the downgrade.
3. THE Extension options page SHALL allow the user to opt out of layout-driven repositioning entirely on a per-host basis, in which case pins remain at their stored coordinates.

### Requirement 52: Pin Clustering

**User Story:** As a user on a heavily-annotated page, I want overlapping pins to cluster, so that I can still click each one.

#### Acceptance Criteria

1. WHEN two or more Annotation_Pins on a page would overlap within an N-pixel radius (default 24 px) at the current zoom level, THE Extension SHALL render a single Cluster_Pin labeled with the count of contained Annotations.
2. WHEN a user clicks a Cluster_Pin, THE Extension SHALL display a popover listing the contained Annotations AND SHALL allow the user to select one to view its details.
3. WHEN the user zooms in or the page layout changes such that pins no longer overlap, THE Extension SHALL re-expand the Cluster_Pin into individual pins.

### Requirement 53: Chrome Web Store Listing Readiness

**User Story:** As a maintainer, I want the repository to contain everything needed to publish the Extension to the Chrome Web Store, so that releases do not require last-minute scrambling.

#### Acceptance Criteria

1. THE repository SHALL contain a Chrome Web Store listing artifact bundle under `extension/store/` including a privacy policy URL, a 128×128 store icon, at least three 1280×800 promotional screenshots, a description under 132 characters, a long description under 16,000 characters, and a support email.
2. THE Extension `manifest.json` `version` field SHALL follow Semantic Versioning (`MAJOR.MINOR.PATCH`).
3. THE repository SHALL contain a `extension/CHANGELOG.md` with one entry per published version.

### Requirement 54: API Server Hexagonal Architecture

**User Story:** As a maintainer, I want the API_Server organized as a hexagonal (ports and adapters) architecture, so that domain logic can be tested without infrastructure, replaced inbound and outbound adapters do not perturb the core, and new triggers (workers, sockets, queues) reuse the same use cases.

#### Acceptance Criteria

1. THE API_Server source tree SHALL contain three top-level layers: a Domain layer (`server/src/domain/`), an Adapters layer (`server/src/adapters/` split into `inbound/` and `outbound/`), and a Composition layer (`server/src/composition/`).
2. THE Domain layer SHALL contain entities, value objects, domain errors, use cases, and Inbound_Port and Outbound_Port interfaces only, AND SHALL not import any module from `server/src/adapters/`, `server/src/composition/`, `express`, `socket.io`, `knex`, `pg`, `bcrypt`, `nodemailer`, `aws-sdk`, `@aws-sdk/*`, `pino`, or `pino-http`.
3. WHEN a Use_Case requires data from or sends data to infrastructure, THE Use_Case SHALL receive the dependency through a constructor parameter typed by an Outbound_Port interface defined in the Domain layer, AND SHALL not import any concrete adapter.
4. THE Inbound Adapters (HTTP route handlers under `adapters/inbound/http/`, WebSocket handlers under `adapters/inbound/websocket/`, and background workers under `adapters/inbound/workers/`) SHALL each be thin, MUST validate inputs at the edge using Zod, MUST invoke a single Use_Case per request or message, and MUST translate Use_Case results into the adapter's response or side effect.
5. THE Outbound Adapters (under `adapters/outbound/{postgres,s3,smtp,socket,bcrypt,jwt,clock,logger}/`) SHALL each implement exactly one Outbound_Port interface from the Domain layer, AND SHALL be the only files in the codebase that import their corresponding infrastructure SDK.
6. THE Composition_Root in `server/src/composition/container.ts` SHALL be the only module that imports both Domain Use_Cases and concrete adapters, AND SHALL wire them at process boot.
7. FOR every Use_Case in the Domain layer, THE test suite SHALL include at least one unit test that exercises the Use_Case using in-memory fake implementations of its Outbound_Ports and asserts behavior without contacting any database, network, or filesystem.
8. THE repository SHALL include a CI lint rule (such as `eslint-plugin-import` `no-restricted-paths` or `dependency-cruiser`) that fails the build IF any file under `server/src/domain/` imports any module under `server/src/adapters/` OR any restricted infrastructure package listed in criterion 2.

## Future Requirements (V2)

### V2-1: Session Replay

**User Story:** As a viewer of a bug report, I want a short replay of the user's interactions leading up to the report, so that I can reproduce the issue without guesswork.

**Rationale (V2 deferral):** Bundle size (rrweb is ~30 KB minified plus per-second event payload), privacy implications around password and sensitive form-data capture, the redaction work required, and the storage and cost implications of persisting replay data.

**Integration constraints when taken up:** SHALL integrate with Requirement 45 (PII auto-redaction) and Requirement 47 ("what gets sent" disclosure). SHALL bound the captured window (e.g., last 30 seconds). SHALL allow per-host opt-out via the Extension options page.
