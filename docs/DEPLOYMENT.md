# Pinpoint — Deployment

How to build, migrate, run and observe Pinpoint outside the local Compose
stack. For the variable list see the
[Environment variables reference](../README.md#10-environment-variables-reference);
for the secrets an exposed deployment must provide see
[Self-hosting](../README.md#self-hosting).

## 1. Images

Two images, both built with the **repository root as the Docker context**
(the Dockerfiles copy every workspace manifest so `npm ci` can resolve the
lockfile):

```bash
docker build -f server/Dockerfile    -t pinpoint-server    .
docker build -f dashboard/Dockerfile -t pinpoint-dashboard .
```

- `server/Dockerfile` builds `@pinpoint/shared`, `@pinpoint/server` and the
  widget bundle. The runtime stage runs `node dist/index.js` on port 3001,
  sets `NODE_ENV=production` and `WIDGET_DIST_DIR=/app/widget/dist`. The same
  image runs migrations (`npm run migrate`, which loads the TypeScript
  knexfile through `ts-node`, so dev dependencies are installed on purpose).
- `dashboard/Dockerfile` builds the dashboard and serves it with
  `vite preview` on port 4173, proxying to the API via `API_PROXY_TARGET`.

## 2. Required production secrets

The server refuses to boot (exit 1) when exposed — `NODE_ENV=production`,
`PINPOINT_SELF_HOST=1`, or a non-loopback `HOST` without
`PINPOINT_LOCAL_DEV=1` — and any of these is missing or a dev default:
`JWT_SECRET` (≥ 32 bytes), `CORS_ORIGIN` (exact origin, not `*`),
`DB_PASSWORD` (not `postgres`), `OAUTH_STATE_SECRET`,
`INTEGRATION_ENCRYPTION_KEY` (32 bytes), `METRICS_TOKEN` (≥ 16 characters;
PP-07 — without it `/metrics` is readable by anyone behind the proxy), and
`COOKIE_INSECURE` must not be `true`. The full table, formats and generation
commands are in the README's [Self-hosting](../README.md#self-hosting) section.

On AWS, `infrastructure/terraform/ecs.tf` delivers `DB_PASSWORD`,
`JWT_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET` and
`METRICS_TOKEN` as SSM `SecureString` parameters injected through the task
definition's `secrets` block (Terraform variables `db_password`, `jwt_secret`,
`integration_encryption_key`, `oauth_state_secret`, `metrics_token`; the task
execution role is granted `ssm:GetParameters` on exactly those parameters).

### Behind a load balancer: `TRUST_PROXY`

Express only trusts `X-Forwarded-For` when told to. With the default
(`TRUST_PROXY` unset = `false`) every client behind an ALB shares the ALB's IP,
so the per-IP rate limiters (`/api` general limiter, auth limiter) become one
global bucket. Set `TRUST_PROXY=1` (one trusted hop — the ALB; the Terraform
task definition does this). Use a hop count or an explicit subnet list, never
`true`: that trusts any client-supplied header and the preflight rejects it on
an exposed deployment. Leave it unset when the API is reached directly.

Related knobs: `TENANT_RATE_LIMIT_MAX` (per-organisation requests/hour,
default 1000) and `AUTH_RATE_LIMIT_IP_MAX` (per-IP auth-endpoint requests per
minute, default 20 — raise for load/E2E runs from a single machine).

## 3. Migrations

Migrations are `knex migrate:latest` (`npm run migrate`). The `production`
profile of `server/knexfile.ts` uses `DATABASE_URL` if set, otherwise the same
`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` the API reads — which is
what the ECS task definition provides.

In CI the database sits in a private subnet that GitHub-hosted runners cannot
reach, so migrations run **inside the VPC** via
`infrastructure/scripts/ecs-migrate.sh`:

```bash
ECS_CLUSTER=<cluster> ECS_SERVICE=<service> ./infrastructure/scripts/ecs-migrate.sh
```

It reads the service's current task definition and network configuration,
starts a one-off Fargate task from that task definition with the command
overridden to `npm run migrate` (same image, env and secrets as the API),
waits for it to stop, and exits non-zero unless the container's exit code
is 0. Both deploy workflows run it after the image push and before
`update-service`.

The deploy principal needs: `ecs:RunTask`, `ecs:DescribeTasks`,
`ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:UpdateService`, and
`iam:PassRole` on the task role and the task execution role (the script's `aws
ecs wait tasks-stopped` call is covered by `ecs:DescribeTasks`), plus ECR push.
Terraform does not create that principal (it is the IAM user/role behind the
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` repository secrets), but
`infrastructure/terraform/ci_deploy.tf` defines the least-privilege managed
policy `pinpoint-<env>-ci-deploy` (output `ci_deploy_policy_arn`) — attach it
to that principal, or to a GitHub OIDC role, out of band. `RunTask` is scoped
to the API task-definition family on the environment's cluster; `PassRole` is
scoped to the two task roles and `iam:PassedToService=ecs-tasks.amazonaws.com`.

For Compose the `migrate` service does the same job before `api` starts.

## 4. The `:latest` tag coupling

`infrastructure/terraform/ecs.tf` pins the task definition's image to
`<ecr-repo>:latest`. Consequences:

- Both deploy workflows push `:<git-sha>` **and** `:latest` (production also
  pushes `:production`). If `:latest` is not updated,
  `update-service --force-new-deployment` redeploys the previous image.
- The migration task is started from the same task definition, so it also
  pulls `:latest`; that is why migrate must run after the push.
- Rolling back means re-pointing the service at the previous task-definition
  revision (the production workflow does this), but `:latest` itself still
  refers to the newest build. Pin the task definition to the `<git-sha>` tag
  if you need rollbacks to be image-exact.
- The ECR repository is declared with `image_tag_mutability = "MUTABLE"` so
  the moving tags (`:latest`, `:production`) can be re-pushed on every deploy
  (an `IMMUTABLE` repo rejected the second push of any tag). Every build is
  still pushed under its immutable `<git-sha>` tag, and `scan_on_push` stays
  enabled so each push is vulnerability-scanned. If you need image-exact
  deploys, pin the task definition to the `<git-sha>` tag instead.

## 5. Graceful shutdown

On `SIGTERM` (or `SIGINT`) the API stops the notification, digest,
integration-refresh and webhook workers (awaiting in-flight work), drops idle
keep-alive connections, closes Socket.IO and the HTTP server, and gives
in-flight requests up to **10 seconds** before force-closing remaining
sockets. It then closes Redis and the database pool and exits 0; a failure in
that sequence exits 1. `GET /health/live` returns 503 (`shutting_down`) once
a signal has been received, so load balancers can stop routing before the
drain ends. Set the orchestrator's stop timeout above 10 s (ECS default 30 s).

## 6. Health and metrics

- `GET /health` and `GET /health/ready` — 200 with
  `{"status":"ok"|"degraded","checks":{…},"info":{…}}`; **503** when the
  database check fails. `GET /health/live` is the liveness probe.
- `GET /metrics` — Prometheus text format (`prom-client`):
  `http_requests_total`, `http_request_duration_seconds` (labels `method`,
  `route`, `status`, with `route` as the matched route pattern) and default
  Node process metrics.
  - With `METRICS_TOKEN` set, scrapers must send
    `Authorization: Bearer $METRICS_TOKEN` (401 otherwise).
  - Without it (local stacks only), only direct loopback / private-network
    callers are served and any request carrying `X-Forwarded-For` / `Forwarded`
    is refused (403). Behind a proxy the socket address is the proxy's, so the
    boot preflight **now refuses to start an exposed deployment without
    `METRICS_TOKEN`**; still do not publish `/metrics` through the public
    listener. The Terraform task definition injects it from the `metrics_token`
    variable (SSM `SecureString`, ≥ 24 characters).
  - The `route` label is bounded: unmatched requests under `/api/v1/<area>/*`
    use a fixed allow-list of areas, everything else is `unmatched`.
  - Prometheus: add the token under `authorization` in the scrape config
    (see the commented block in `infrastructure/monitoring/prometheus.yml`).

## 7. Serving the dashboard

The dashboard must be **same-origin with the API** (cookies are first-party;
the session cookie is `SameSite=Lax`, and cookie-authenticated WebSockets are
accepted only from the `CORS_ORIGIN` origin). Either run the dashboard image
with `API_PROXY_TARGET=http://<api-host>:3001`, or put a reverse proxy / load
balancer in front of both and route these paths to the **API**; everything
else goes to the dashboard's static files / SPA:

| Path | Notes |
|---|---|
| `/api/*` | REST API (`/api/v1`) |
| `/socket.io/*` | Socket.IO — must allow WebSocket upgrade |
| `/widget/*` | Serves `pinpoint-widget.js` for the embeddable widget |
| `/review/*/frame` | Review-link proxy document. Only the `/frame` suffix goes to the API; `/review/:linkId` itself is a dashboard SPA route |

Set `CORS_ORIGIN` and `APP_URL` to the public dashboard origin (`https://…`).
Do not set `COOKIE_INSECURE` on an HTTPS deployment.

## 8. Pre-deploy checklist

Do these in order the first time you stand up an environment, and re-check
items 3-6 before every deploy.

1. **Terraform inputs.** Provide the sensitive variables via
   `TF_VAR_*` or a git-ignored tfvars file (never in `envs/*.tfvars`):
   `db_password` (not `postgres`), `jwt_secret` (>= 32 bytes,
   `openssl rand -base64 48`), `integration_encryption_key`
   (`openssl rand -base64 32`), `oauth_state_secret` (>= 32 chars,
   `openssl rand -base64 48`), `metrics_token` (>= 24 chars,
   `openssl rand -base64 32`). Terraform's variable validation rejects short
   `oauth_state_secret` / `metrics_token` values.
2. **Validate, then plan (never apply from CI).** From
   `infrastructure/terraform/`: `terraform fmt -check -recursive`,
   `terraform init`, `terraform validate`,
   `terraform plan -var-file=envs/<env>.tfvars`. Review the plan; apply
   manually.
3. **Task secrets are wired.** Verify in the plan / console that the task
   definition's `secrets` block has `DB_PASSWORD`, `JWT_SECRET`,
   `INTEGRATION_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET` and `METRICS_TOKEN`
   (SSM `SecureString`: `/pinpoint/<env>/{db-password,jwt-secret,
   integration-encryption-key,oauth-state-secret,metrics-token}`) and that the
   execution role's `read-task-secrets` policy lists all five parameter ARNs.
   Without `OAUTH_STATE_SECRET` the container exits 1 at boot (config
   preflight), which the ECS circuit breaker turns into a rollback.
4. **CI principal can migrate and deploy.** `ci_deploy_policy_arn`
   (`ci_deploy.tf`) is attached to the principal behind the repository's AWS
   secrets: it grants `ecs:RunTask` (migration task) and `iam:PassRole` for the
   task + execution roles. Without `iam:PassRole` the migrate job fails with
   `AccessDeniedException` before any task starts.
5. **ECR tag mutability.** The repository is `MUTABLE` on purpose: the deploy
   workflows re-push `:latest` (and `:production`) on every deploy, and the
   task definition runs `:latest`. An `IMMUTABLE` repository rejects the second
   push of any tag. Every build also gets an immutable `:<git-sha>` tag; confirm
   with `aws ecr describe-repositories --repository-names pinpoint-api
   --query 'repositories[0].imageTagMutability'` -> `"MUTABLE"`.
6. **GitHub configuration.** Repository/environment secrets exist:
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
   `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE` (and optionally
   `SLACK_WEBHOOK_URL`). The `production` environment should require
   reviewers. `main` is green on the `CI` workflow (lint/typecheck, unit
   tests on Postgres, the Playwright `e2e` job) — staging deploys on every push
   to `main` via `deploy-staging.yml`, which is the only staging deploy path.
7. **Public DNS/TLS.** `domain_name` resolves to the ALB, the ACM certificate
   (DNS validation) is issued, and `CORS_ORIGIN`/`APP_URL` (derived from
   `domain_name`) match the origin users load the dashboard from. The dashboard
   must be same-origin with the API (see §7).
8. **After the deploy.** `curl -f https://<domain>/health` is 200 (the
   workflow's smoke test), `GET /metrics` returns 401 without the bearer
   token, and `GET /widget/pinpoint-widget.js` is served.

## 9. Continuous integration

`.github/workflows/ci.yml` runs on every push/PR to `main`:

| Job | What it does |
|---|---|
| `lint-typecheck` | `npm run typecheck`, `npm run lint` |
| `test` | Postgres 16 service container, migrations, full Vitest suite with coverage (`DB_*` point at the service) |
| `e2e` | Postgres + Mailpit service containers; builds every workspace, migrates, starts the API (`server/dist`) and the Vite dashboard, seeds the verified `pro` account (`infrastructure/scripts/ci-seed-e2e.sh`), installs Chromium/Firefox/WebKit, runs the `api`, `browser`, `browser-firefox`, `browser-webkit` projects, then the MV3 `extension` project under `xvfb-run`. On failure it uploads the HTML reports, `test-results/` (traces/screenshots) and the API/dashboard logs as artifacts |
| `build-docker` (main only) | Builds the server and dashboard images (no push) |

Third-party actions are pinned to full commit SHAs (tag in a trailing comment).
Resolve a new one with `git ls-remote https://github.com/<owner>/<repo>
refs/tags/<tag> 'refs/tags/<tag>^{}'` (use the `^{}` commit for annotated tags).
