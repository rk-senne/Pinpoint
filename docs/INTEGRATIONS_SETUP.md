# Integrations and social sign-in: owner checklist

How to switch on Google / GitHub sign-in and the Slack, Jira, Linear and GitHub
integrations, plus the ClickUp and Asana delivery adapters. Everything here is derived
from reading the code (file citations inline). **It has not been run against
real provider accounts.** Expect to adjust provider-console wording.

Examples use `https://feedback.example.com` as the public origin
(`APP_URL` = `CORS_ORIGIN` = `https://$DOMAIN` in `deploy/docker-compose.prod.yml`).

## 0. Read this first: what works today

| Provider | OAuth connect | Token connect (`accessToken` in body) | "Send to…" delivery |
|---|---|---|---|
| GitHub | yes | yes | yes |
| Jira | yes | yes | yes |
| Linear | yes | yes | yes |
| ClickUp | yes | yes | yes |
| Asana | yes | yes | yes |
| Slack | yes | yes | **no** (connect only; nothing sends Slack messages yet) |

How the OAuth flow works from the dashboard (Settings → Integrations):

1. **Connect** sends `POST /api/v1/integrations/:provider/connect`. If the provider is
   configured on the server the browser is redirected to the provider's consent page;
   otherwise the page says the provider is not configured (`501 INTEGRATION_NOT_CONFIGURED`).
2. The provider redirects to `/api/v1/integrations/:provider/callback`, which exchanges the
   code (through the SSRF egress guard, https only), stores the tokens encrypted, and redirects
   back to `/integrations?connected=<provider>` (or `?error=<code>`).
3. **Finish setup** loads `GET /api/v1/integrations/:provider/targets` (the repos, projects,
   teams or lists the token can see) and saves your choice with
   `PATCH /api/v1/integrations/:provider`. Jira picks its site automatically when the account has
   exactly one. Until this step is done the card says "Connected, but not finished".
4. **Send to…** on any annotation now creates the issue/task.

Sources: `server/src/adapters/inbound/http/integrations.routes.ts`,
`server/src/services/integrations/oauthExchange.ts` (OAuth endpoints and default scopes),
`server/src/services/integrations/targets.ts` (target discovery),
`dashboard/src/pages/IntegrationsPage.ts`.

Tested against fake provider endpoints only. Before relying on a provider, register the app,
set its variables, and do one real connect + "Send to…".

## 1. Common prerequisites

Set on the API (production names and defaults: README "Environment variables reference"):

- `APP_URL=https://feedback.example.com`. Integration OAuth redirects go to
  `${APP_URL}/api/v1/integrations/<provider>/callback`
  (`callbackBaseUrl: config.appUrl`, `server/src/composition/container.ts:513`;
  path built in `integrations.routes.ts:74-75`). The Caddy/vite proxy forwards `/api`, so this is the public origin.
- `OAUTH_STATE_SECRET` and `INTEGRATION_ENCRYPTION_KEY`: required on exposed deployments
  (already required by `deploy/docker-compose.prod.yml`). The encryption key protects
  stored access/refresh tokens (`server/src/composition/config.ts`, `PgIntegrationRepo.ts`).
- **Pass the new variables through to the `api` service.** `deploy/docker-compose.prod.yml`
  lists the API `environment:` explicitly and (at time of writing) contains none of
  `GOOGLE_*`, `GITHUB_CLIENT_*`, `OAUTH_CALLBACK_BASE_URL`, `INTEGRATION_*_CLIENT_*`.
  Putting them in `deploy/.env.production` alone has no effect until the compose file
  forwards them (see the diff in the hand-off note).
- Outbound calls (token exchange, issue creation) go through the SSRF egress guard
  (`server/src/services/egressGuard.ts` `safeFetch`: https only, DNS-pinned to a public
  IP, private ranges blocked, 10 s timeout). The provider endpoints below are all https.
- Only org **owners/admins** can connect (`requireOrgAdmin`). The callback also requires
  the same admin's session and a state cookie issued within the last 10 minutes.

## 2. Sign in with Google / GitHub (login, not integrations)

Routes: `GET /api/v1/auth/oauth/{google,github}` and `.../callback`
(`server/src/adapters/inbound/http/oauth.routes.ts`). Enabled per provider only when both
id and secret are set (`config.ts:200-205`). If not enabled the route returns 404
`NOT_FOUND "<provider> OAuth not configured."`.

**Redirect URI** = `${OAUTH_CALLBACK_BASE_URL}/api/v1/auth/oauth/<provider>/callback`
(`oauth.routes.ts:112,175`). `OAUTH_CALLBACK_BASE_URL` defaults to
`http://localhost:<PORT>`, which is wrong behind a proxy. **Set it to
`https://feedback.example.com`.**

### Google

1. Console: <https://console.cloud.google.com/apis/credentials> → Create credentials → OAuth client ID
   (configure the OAuth consent screen first if prompted).
2. Application type: Web application. Name: `Pinpoint`.
3. Authorized redirect URI: `https://feedback.example.com/api/v1/auth/oauth/google/callback`
   (authorized JavaScript origins are not used; the flow is server-side).
4. Scopes requested by the code: `openid email profile` (`GoogleOAuthProvider.ts`). These are
   non-sensitive; no verification needed.
5. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE_URL`.

### GitHub

1. Console: <https://github.com/settings/developers> → OAuth Apps → New OAuth App
   (or the org's Settings → Developer settings).
2. Application name `Pinpoint`; Homepage URL `https://feedback.example.com`;
   Authorization callback URL `https://feedback.example.com/api/v1/auth/oauth/github/callback`.
3. Scopes requested by the code: `read:user user:email` (`GitHubOAuthProvider.ts:13`); nothing to tick in the console.
4. Env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE_URL`.

**Test:** open `https://feedback.example.com/auth`, use the provider button (if the
button is absent, check the dashboard auth page), or visit
`/api/v1/auth/oauth/google` directly; you should be redirected to the provider and
land back signed in. Failures redirect to `${APP_URL}/auth?error=oauth_failed`
(bad/expired state, provider rejected the code, or redirect-URI mismatch; the API log
has the detail). Note these use the same variable names as the integration GitHub
app below but are **different variables and a different OAuth app** (`GITHUB_CLIENT_ID`
vs `INTEGRATION_GITHUB_CLIENT_ID`).

## 3. Integrations: the token path (works today)

For GitHub, Jira, Linear (and Slack, storage only). As an org owner/admin, with a bearer
JWT (extension/login token) or session cookie plus `X-CSRF-Token`:

```bash
curl -X POST https://feedback.example.com/api/v1/integrations/github/connect \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"accessToken":"<token>","config":{"owner":"my-org","repo":"my-repo"}}'
# → 201 {"integration":{"id":"…","provider":"github","enabled":true}}
```

Body schema: `accessToken`, optional `refreshToken`, optional `config`
(`ConnectSchema`, `integrations.routes.ts`). Reconnecting replaces token **and** config
(`PgIntegrationRepo.upsert`), so always resend the full `config`.

| Provider | Token to create | `config` keys (all strings) |
|---|---|---|
| GitHub | Fine-grained PAT at <https://github.com/settings/personal-access-tokens/new>, repository access to the target repo, **Issues: Read and write** (a classic PAT needs `repo`) | `owner`, `repo` |
| Linear | Personal API key at <https://linear.app/settings/api> (sent raw in `Authorization`) | `teamId` (UUID of the team; Linear → Settings → API, or the GraphQL `teams` query) |
| Jira | Atlassian OAuth 2.0 (3LO) access token; see note | `cloudId`, `projectKey`; optional `issueType` (default in `jiraProvider.ts`), `siteUrl` (e.g. `https://acme.atlassian.net`, used to build the browse link) |
| Slack | Bot token (`xoxb-…`) | none required; stored only |

Jira note: delivery calls `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue`
with `Authorization: Bearer <token>`, which accepts OAuth 2.0 tokens, not plain
email+API-token basic auth. A static OAuth token expires, so for Jira prefer section 4.
`cloudId` is returned by `GET https://api.atlassian.com/oauth/token/accessible-resources`.

ClickUp (`listId`) and Asana (`projectGid`) adapters read those config keys and send
the token as `Authorization: <token>` / `Bearer <token>`, but see section 0: there is
no way to store their token yet.

**Test:** Dashboard → Settings → Integrations should show the card as Connected
(its "Config:" line lists the non-secret config keys). Then open a project, pick an
annotation, **Send to…** → provider. The call is
`POST /api/v1/annotations/:id/deliver {"provider":"github"}`; success is `201 {link:{externalUrl,…}}`
(title `[Pinpoint #N] …`) and the issue appears in the tracker; repeating it is idempotent (200, same link).
`GET /api/v1/annotations/:id/deliveries` lists status and `lastError`.
(`server/src/adapters/inbound/http/deliver.routes.ts`).

## 4. Integrations: the OAuth path (recommended)

Server side is implemented: `POST /api/v1/integrations/:provider/connect` with an empty
body returns `{redirectUrl}` when the provider is configured; the provider redirects to
`https://feedback.example.com/api/v1/integrations/<provider>/callback`, which exchanges
the code and stores encrypted tokens. A provider is configured only when **both** vars
are set (`loadIntegrationOAuthProviders`, `oauthExchange.ts`). Optional
`INTEGRATION_<PROVIDER>_SCOPES` (space/comma separated) overrides the default scopes.

Redirect URI to register everywhere: `https://feedback.example.com/api/v1/integrations/<provider>/callback`.

### GitHub (integration)

- Register: <https://github.com/settings/developers> → New OAuth App. Name `Pinpoint Integration`,
  Homepage `https://feedback.example.com`, callback `…/api/v1/integrations/github/callback`.
- Default scope: `repo` (needed to open issues on private repos; use
  `INTEGRATION_GITHUB_SCOPES=public_repo` for public only).
- Env: `INTEGRATION_GITHUB_CLIENT_ID`, `INTEGRATION_GITHUB_CLIENT_SECRET`.
- Delivery target: chosen in **Finish setup** after connecting.

### Jira (Atlassian)

- Register: <https://developer.atlassian.com/console/myapps/> → Create → OAuth 2.0 integration.
  Authorization → OAuth 2.0 (3LO) → callback URL `…/api/v1/integrations/jira/callback`.
  Permissions → Jira API → add `read:jira-work`, `write:jira-work`. Settings has the client ID/secret.
- Default scopes: `read:jira-work write:jira-work offline_access` (refresh tokens).
  The authorize URL adds `audience=api.atlassian.com&prompt=consent`.
- Env: `INTEGRATION_JIRA_CLIENT_ID`, `INTEGRATION_JIRA_CLIENT_SECRET`.
- Delivery target: chosen in **Finish setup** after connecting.

### Linear

- Register: <https://linear.app/settings/api/applications/new>. Name `Pinpoint`, callback URL
  `…/api/v1/integrations/linear/callback`.
- Default scopes: `read,write`. Env: `INTEGRATION_LINEAR_CLIENT_ID`, `INTEGRATION_LINEAR_CLIENT_SECRET`.
- Delivery target: chosen in **Finish setup** after connecting.

### Slack

- Register: <https://api.slack.com/apps> → Create New App → From scratch. OAuth & Permissions →
  Redirect URLs → `…/api/v1/integrations/slack/callback`; Bot Token Scopes `chat:write`,
  `incoming-webhook`.
- Env: `INTEGRATION_SLACK_CLIENT_ID`, `INTEGRATION_SLACK_CLIENT_SECRET`.
- Connecting stores the token and workspace name only. No Slack delivery exists.

### ClickUp

- Register: ClickUp → Settings → Apps → **Create new app**. Redirect URL
  `…/api/v1/integrations/clickup/callback` (ClickUp matches the host).
- No scopes (ClickUp grants workspace access chosen on the consent page). Tokens don't expire.
- Env: `INTEGRATION_CLICKUP_CLIENT_ID`, `INTEGRATION_CLICKUP_CLIENT_SECRET`.
- Delivery target: a List, chosen in **Finish setup**.

### Asana

- Register: <https://app.asana.com/0/my-apps> → **Create new app** → OAuth → add redirect URL
  `…/api/v1/integrations/asana/callback`.
- Env: `INTEGRATION_ASANA_CLIENT_ID`, `INTEGRATION_ASANA_CLIENT_SECRET`.
- Delivery target: a project (and its workspace), chosen in **Finish setup**.

## 5. Errors

| Code / HTTP | Where | Meaning and fix |
|---|---|---|
| `INTEGRATION_NOT_CONFIGURED` 501 | `/connect` (empty body) or `/callback` | `INTEGRATION_<PROVIDER>_CLIENT_ID`/`_CLIENT_SECRET` not both set on the API (or not forwarded into the container). Restart after setting. Use the token path to avoid it. |
| `OAUTH_DENIED` 400 | `/callback?error=…` | User cancelled consent, or the provider returned an error. Retry. |
| `OAUTH_EXCHANGE_FAILED` 502 | `/callback` | Token exchange failed: wrong secret, **redirect URI not identical** to the registered one (scheme, host, path), reused code, or the API can't reach the provider (egress guard, DNS). The message is generic by design. |
| `VALIDATION` 400 "Invalid or expired OAuth state" / "signature invalid" | `/callback` | Cookie older than 10 min, different admin or org, cookie not sent (`COOKIE_INSECURE`/https mismatch), or `OAUTH_STATE_SECRET` changed mid-flow. Start over from the same browser. |
| `VALIDATION` 400 "Invalid provider" | `/connect`, `/callback` | Not in slack/jira/linear/github. |
| 403 | integration routes | Caller is not an org owner/admin. |
| `INTEGRATION_NOT_CONNECTED` 409 | `/annotations/:id/deliver` | No enabled integration with a token for that provider in the org. |
| 4xx/5xx with provider message (`status='failed'`, `lastError`) | `/deliver` | Permanent config errors (e.g. `missing required config 'repo'`, 401/403/404 from the tracker) are not retried. Transient ones (5xx/network) return 502; re-POST to retry. |

## 6. Variable reference

| Variable | Read in |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE_URL` | `server/src/composition/config.ts:200-206` |
| `INTEGRATION_{SLACK,JIRA,LINEAR,GITHUB}_CLIENT_ID`, `_CLIENT_SECRET`, `_SCOPES` | `server/src/services/integrations/oauthExchange.ts` (`loadIntegrationOAuthProviders`, called from `config.ts:195`) |
| `APP_URL` | `config.ts` → `container.ts:513` |
| `OAUTH_STATE_SECRET`, `INTEGRATION_ENCRYPTION_KEY` | `config.ts`, preflight `server/src/config.ts` |
