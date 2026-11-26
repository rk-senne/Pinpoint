# Pinpoint — Go-live plan (cheapest sensible path)

Owner actions only, cheapest first. Everything here is a plan, not a record of something done.

> **Price data warning.** The authoring session had **no web access**, so the figures below were **not fetched today**.
> Hosting, e-mail, storage and store fees below were checked against vendor pages and recent public sources on **25 Nov 2026**. Prices change (Hetzner raised cloud prices twice in 2026), all exclude VAT, and SOC 2 / pen-test ranges are rough public estimates.
> Every row links the vendor's own pricing page; fill the "Checked on" column when you verify it, and use the linked
> calculators for any bill estimate. Treat a price here as "order of magnitude", never as a quote. Nothing here is a
> compliance, legal or tax claim.

State this plan assumes (verified by earlier stages, branch `feat/enhancement-roadmap`, PR #2 on `rk-senne/Pinpoint`): local-disk screenshots are the
default (S3 optional); `deploy/install.sh` one-command VPS installer, `deploy/backup.sh`, `deploy/upgrade.sh` exist; Slack delivery
and auto-notify implemented (tested against a fake Slack only); Firefox 161 + ESR 140/128 pass the real-browser harness; AMO
package + reproducible source archive ready (`docs/STORE_SUBMISSION.md`); Safari Xcode project builds unsigned, **not yet run in
Safari**; API image runs as non-root; RLS enforced with the `pinpoint_app` role; integrations tested against fake providers only.

## Summary table (cheapest path)

| # | Step | Owner | Time | One-off cost | Monthly cost |
|---|---|---|---|---|---|
| 1 | Merge PR #2 (GHCR dry-run already passed) | Owner | 1–2 h | 0 | 0 |
| 2 | Domain | Owner | 15 min | ~US$10–15/yr (≈ $1/mo) | ~0–1 |
| 3 | VM (2 vCPU / 4 GB: OVH VPS-1 or Hetzner CX23) + `install.sh` | Owner | 1–2 h | 0 | ≈ $4.54 (OVH) – €5.99 (Hetzner) |
| 4 | Backups: on-box `backup.sh` + off-box copy | Owner | 1 h | 0 | 0–1 (free tier of an object store or a second cheap box) |
| 5 | Transactional e-mail (free tier) + SPF/DKIM/DMARC | Owner | 1–2 h | 0 | 0 |
| 6 | Screenshots: stay on local disk | — | 0 | 0 | 0 (included in backups) |
| 7 | One real integration (Slack or GitHub first) | Owner | 1–2 h each | 0 | 0 |
| 8 | Chrome Web Store | Owner | 1–2 h + review | ~US$5 once | 0 |
| 9 | Firefox AMO | Owner | 1 h + review | 0 | 0 |
| 10 | Safari / Apple Developer Program (only if users need it) | Owner | 1–2 days | — | ~US$99/yr (≈ $8/mo) |
| 11 | SOC 2 | Owner | wait until a customer requires it | see §8 | see §8 |
| 12 | Penetration test | Owner | 1–3 weeks lead time | see §8 | — |
| | **Minimum to be live (steps 1–7, Chrome + Firefox)** | | **~1 working day + store reviews** | **≈ $15–20** (domain + Chrome fee) | **≈ $5–7** |

Rule of thumb: don't pay for anything in the "upgrade when" column until the trigger is true.

---

## 1. Merge PR #2 (free, 1–2 h)

1. ✅ **Done on 26 Nov 2026** ([run 45827341445](https://github.com/rk-senne/Pinpoint/actions/runs/45827341445)): every job passed and it pushed `ghcr.io/rk-senne/pinpoint/server:test-bc0c5e2…` and `…/dashboard:test-bc0c5e2…` without touching `latest`. Re-run it after any CI change. **Run the GHCR publish dry-run first** (proves the publish pipeline from the branch without touching `latest`):
   GitHub → Actions → **CI** → *Run workflow* → branch `feat/enhancement-roadmap` → tick **`publish_tag`**. It runs lint/typecheck, unit tests, e2e and then
   publishes only `ghcr.io/rk-senne/pinpoint/{server,dashboard}:test-<sha>` (never `latest`; `packages: write` only on that job).
   Check: all jobs green, both `test-<sha>` packages appear under the repo's Packages, and `docker manifest inspect ghcr.io/rk-senne/pinpoint/server:test-<sha>` works.
2. On the PR confirm: required checks green (`lint-typecheck`, `test`, `e2e`, `docker-build`, `shell-scripts`, `compose-smoke` if it triggers); no secrets in the diff
   (`git diff main... | grep -iE 'secret|password|key'` skim — only CI throwaway values should appear); the migrations list
   (notably `20261125000101_row_level_security.ts`, which creates the `pinpoint_app` role) is what you expect; Docs read right.
3. **Set branch protection on `main` first** (Settings → Branches: require PR + 1 approval + the CI checks, no force-push). Free for public repos; private-repo availability depends on your GitHub plan.
4. Merge. The `main` push publishes `<sha>` and `latest`. Make the GHCR packages **public** (Package settings) so a fresh VPS can pull without a token — or `docker login ghcr.io` on the box with a `read:packages` token.
5. Pin the `<sha>` tag in production rather than `latest` (`PINPOINT_SERVER_IMAGE` / `PINPOINT_DASHBOARD_IMAGE`).

## 2. Domain (~$10–15/yr)

Cheapest: register at an at-cost registrar (Cloudflare Registrar, Porkbun, Namecheap) — `.com` is typically about US$10–13/yr; cheaper TLDs exist but renew pricier
or carry spam reputation. Enable MFA and registrar lock on the account (a hijacked domain = hijacked service, risk R-19).
Pricing: <https://www.cloudflare.com/products/registrar/> · <https://porkbun.com/products/domains>. Checked on: not re-checked.

## 3. Hosting: one small VM (~$5–24/mo)

**Recommendation (cheapest that fits):** OVHcloud **VPS-1** (2 vCores / 4 GB, from $4.54/mo, daily backup included) or, for EU data residency on Hetzner, **CX23** (≈ €5.99/mo with IPv4). Both run the full stack (Postgres, Redis, API, dashboard, Caddy) for a small team; move to 4 vCPU / 8 GB (OVH VPS-2 ≈ $8.50) when Postgres or the API regularly exceed ~70 % CPU or RAM. DigitalOcean ($24) is 3–5× the price for the same shape and only worth it for its UX.

Recommended size for Postgres + Redis + API + dashboard + Caddy for a small team (≤ ~20 users, light traffic):
**2 vCPU, 4 GB RAM, 40–80 GB SSD**, Ubuntu 24.04 LTS, IPv4 included. 2 GB RAM boots but leaves no headroom for the Postgres + Node
+ image-pull peaks; add 2 GB swap if you start there. Disk grows with screenshots (PNG ~100–500 KB each) and backups — plan ≥ 40 GB.

| Option | Approx. size → price (indicative) | Notes | Pricing / calculator | Checked on |
|---|---|---|---|---|
| **Hetzner Cloud** (EU) | CX23 (2 vCPU / 4 GB / 40 GB, Cost-Optimized) **€5.49 + €0.50 IPv4 ≈ €5.99/mo** after the 15 Jun 2026 adjustment; the Regular-Performance CPX22 is now ≈ €19.49 | EU data residency; 20 TB traffic (EU); hourly billing with monthly cap; snapshots extra | <https://www.hetzner.com/cloud/> · <https://costgoat.com/pricing/hetzner> | 25 Nov 2026 |
| **DigitalOcean** | Basic 2 vCPU / 4 GiB / 80 GiB **$24/mo** (per-second billing since 1 Jan 2026) | Simplest UX, good docs, backups extra | <https://www.digitalocean.com/pricing/droplets> · calculator <https://www.digitalocean.com/pricing/calculator> | 25 Nov 2026 |
| **OVHcloud VPS** | VPS-1 (2 vCores / 4 GB / 40 GB NVMe) **from $4.54/mo**; VPS-2 (4 / 8 GB) from $8.50 (US site) | **Cheapest**; daily backup of the last 24 h included; unlimited traffic; EU/CA/US; support slower | <https://us.ovhcloud.com/vps/> | 25 Nov 2026 |
| **Scaleway** | ~2 vCPU/4 GB ≈ €8–15/mo | French provider, EU residency, pay-per-hour | <https://www.scaleway.com/en/pricing/> · calculator <https://www.scaleway.com/en/pricing/calculator/> | not re-checked |
| **Existing on-prem box** | $0 marginal | Needs static IP/port-forward or a tunnel, UPS, your own patching and physical security; fine for pilots/internal use, weak for a customer-facing SLA | — | — |

**Recommendation:** Hetzner (or OVH if Hetzner has no region you need) for the cheapest reliable start; DigitalOcean if you value
familiarity over price. Choose a region near your users and check the data-residency promises you make to customers.
**Upgrade when:** sustained CPU > 60 % or RAM > 80 % (`docker stats`), disk > 80 %, or customers ask for an SLA (then add a second host, managed Postgres, or provider snapshots + monitoring).

Steps (≈ 1–2 h):
1. Create the VM, add your SSH key, set the firewall to 22/80/443 (installer also enables `ufw`), point the domain's A (and AAAA) record at it **before** installing (`docs/DEPLOYMENT.md §6`).
2. `git clone https://github.com/rk-senne/Pinpoint.git /opt/pinpoint && sudo /opt/pinpoint/deploy/install.sh` (asks `DOMAIN`, `ADMIN_EMAIL`, optional SMTP; generates every secret into `deploy/.env.production`, mode 600; waits for `https://$DOMAIN/api/v1/health`).
3. Copy `deploy/.env.production` into a password manager **now** (`INTEGRATION_ENCRYPTION_KEY` is irreplaceable for stored tokens).
4. Register the first account, then run the post-deploy checks in `docs/DEPLOYMENT.md §6` item 8.

### Backups (≈ 1 h; free to ~$1/mo)
- **On the box (free):** cron `30 2 * * * /opt/pinpoint/deploy/backup.sh >> /var/log/pinpoint-backup.log 2>&1` — dumps Postgres and the screenshots volume (local driver) with 14-day retention.
- **Off-box copy (cheapest that counts):** nightly `rclone`/`rsync` of `/opt/pinpoint/backups` to a *different* provider, client-side encrypted (`rclone crypt` or `age`). Options: a free-tier bucket (§5: Cloudflare R2 / Backblaze B2 each include 10 GB free) while backups are small; or a second €3–4 box; or a storage box. Keep 14–35 days.
- **Provider snapshots** (Hetzner ≈ +20 % of the server price; DO backups ≈ +20 %) are convenient whole-VM rollbacks but crash-consistent, same provider, and not a substitute — add them only if you want one-click server restore, after the off-box copy exists.
- **Do one restore test** on a scratch VM (`docs/compliance/05-business-continuity-backup-dr.md §4`) before telling customers it is safe. A scratch VM for an hour costs cents.

## 4. E-mail (free tiers; SPF/DKIM/DMARC)

Pinpoint needs transactional SMTP: verification links gate login, so **without working e-mail nobody can sign in**. Set `SMTP_HOST/PORT/USER/PASSWORD/SECURE` and `SMTP_FROM` (a domain you control).

| Provider | Free tier (indicative) | Pricing page | Checked on |
|---|---|---|---|
| Brevo (SMTP relay) | **300 e-mails/day, free forever**, no card | <https://www.brevo.com/pricing/> | 25 Nov 2026 |
| Resend | **3,000/mo, max 100/day** (Pro $20/mo for 50k) | <https://resend.com/pricing> | 25 Nov 2026 |
| Amazon SES | pay-as-you-go ≈ $0.10 per 1,000 (free tier only for new accounts / EC2-sent mail; sandbox exit needed) | <https://aws.amazon.com/ses/pricing/> | not re-checked |
| Mailgun | small free/flex tier (limits changed often) | <https://www.mailgun.com/pricing/> | not re-checked |
| Postmark | ~100/mo free | <https://postmarkapp.com/pricing> | not re-checked |

**Cheapest reliable start:** Brevo or Resend free tier (a small team sends well under their caps). **Upgrade when** you exceed the daily/monthly cap or
need dedicated IPs/webhooks/analytics — then SES (cheapest at volume, more setup).

DNS records (all at your DNS host; each provider shows the exact values):
- **SPF:** one TXT at the apex, e.g. `v=spf1 include:<provider-spf> -all` (only one SPF record per domain).
- **DKIM:** the CNAME/TXT records the provider gives you (sign the `SMTP_FROM` domain).
- **DMARC:** TXT at `_dmarc`: start `v=DMARC1; p=none; rua=mailto:dmarc@<domain>`, watch reports for 2–4 weeks, then move to `p=quarantine`, later `p=reject`.
- Verify by registering a test account and checking the headers show SPF/DKIM/DMARC `pass` (Gmail → *Show original*).

## 5. Screenshots: stay on local disk (free)

`STORAGE_DRIVER=local` is the default for the prod stack: PNGs/markup go to the `screenshots` volume (`LOCAL_STORAGE_DIR=/data/screenshots`), served via
15-minute signed URLs, and are **included in `deploy/backup.sh`**. Nothing to buy.

**Move to S3-compatible storage when:** screenshots exceed roughly 30–50 % of the VM disk, you run more than one API host, or you want CDN delivery.
Cheapest options (egress matters because the browser loads images from the bucket):

| Option | Free tier / price (indicative) | Notes | Pricing | Checked on |
|---|---|---|---|---|
| Cloudflare R2 | **10 GB-month free** + 1M Class A / 10M Class B ops; ~$0.015/GB-mo beyond; **no egress fees** | S3 API, `S3_REGION=auto` | <https://developers.cloudflare.com/r2/pricing/> | 25 Nov 2026 |
| Backblaze B2 | ~10 GB free; ~$6/TB-mo; egress free up to ~3× stored | S3 API | <https://www.backblaze.com/cloud-storage/pricing> | not re-checked |

The switch (in `deploy/.env.production`, then `dc up -d api`): `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
(optional `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`). Create the bucket **private** first. **Switching does not migrate existing objects** — copy the volume contents
into the bucket under the `S3_KEY_PREFIX` (`annotations/screenshots`) with `rclone` if you need the old ones, and note `backup.sh` then skips the screenshots archive (back up the bucket).

## 6. Integrations (free to register; ≈ 1–2 h each, one at a time)

Order by likely value (all tested against **fake providers only** — one real connect + Send-to per provider is the acceptance test; see `docs/INTEGRATIONS_SETUP.md`):
1. **Slack** (auto-notify new feedback; easiest to see working; free workspace is fine).
2. **GitHub** (issues; free account/org).
3. **Linear** or **Jira** — whichever your/your first customers' team actually uses (Jira Cloud free plan for ≤ 10 users; Linear free tier).
4. ClickUp, Asana — only on request.
5. Google/GitHub sign-in — only if users ask (not required).

Per provider: register an OAuth app with redirect `https://$DOMAIN/api/v1/integrations/<provider>/callback`; put `INTEGRATION_<PROVIDER>_CLIENT_ID/_SECRET` in
`deploy/.env.production`; **confirm `deploy/docker-compose.prod.yml` forwards those variables to the `api` service** (`docs/INTEGRATIONS_SETUP.md §1` warns it
may not); `dc up -d api`. Checklist: ☐ Connect (consent page appears) ☐ "Finish setup" picks a target ☐ "Send to…" on a real annotation creates the issue/message
with the right text and link ☐ disconnect/reconnect works ☐ token not visible in logs ☐ audit log shows `integration.connected`. Record the result; fix before advertising it.

## 7. Browser stores

| Store | Cost (indicative) | Review time | Pricing/docs | Checked on |
|---|---|---|---|---|
| Chrome Web Store | **US$5 one-time** registration fee | days (first review can take longer) | <https://developer.chrome.com/docs/webstore/register> | 25 Nov 2026 |
| Firefox AMO | **free** | usually hours–days; source upload required (`pinpoint-source-<version>.zip`) | <https://extensionworkshop.com/documentation/publish/> | not re-checked |
| Apple Developer Program (Safari) | **US$99/yr** (+ tax; fee waivers exist for some non-profits/education) | App Review, days | <https://developer.apple.com/programs/> | 25 Nov 2026 |

**Order:** (1) Chrome Web Store, (2) Firefox AMO — both cover the large majority of reviewers and are ≈ free. (3) **Safari only if real users need it**:
the Xcode project builds unsigned but has **never been run in Safari**; do the manual test in `docs/STORE_SUBMISSION.md §2.3` before paying $99.
Steps: Chrome per README "Release Process" (zip `extension/dist`); Firefox per `STORE_SUBMISSION.md §1`. Before submitting, host the privacy policy at a stable URL
(`extension/store/privacy-policy.md`), set the real `VITE_PINPOINT_API_ORIGIN`/Server URL story (the extension defaults to `http://localhost:3001`; production users enter their Server URL).

**Cheaper/faster alternatives that need no store review:** Chrome *unlisted* visibility (still the one-time fee) to share a link with customers only; enterprise
policy/force-install via a self-hosted CRX for an internal team; Firefox *unlisted* channel (AMO signs it, free); load-unpacked for internal testing; or skip
the extension entirely and use the **widget** (one `<script>` tag) and **review links**, which need no install or store at all.

## 8. SOC 2 — cheapest realistic path

**Recommendation: do not start an audit until a customer or a deal requires it.** Use the free parts now, buy later.
1. **Now (free):** adopt what is already true and cheap — branch protection, MFA on all accounts, the policy pack in `docs/compliance/` (fill owners, approve), a first restore test, a first access review. These are good hygiene regardless and shorten any later audit. Do not claim compliance.
2. **When a customer asks:** they usually accept a **security questionnaire + policies + pen-test summary** or a **Type I** first. Ask what they actually need (Type I vs II, which criteria) before spending.
3. **Type I vs Type II:** Type I = controls are *designed* at a date (months of prep, one auditor visit). Type II = controls *operated* over 3–12 months (what most buyers want).
4. **Cost paths** (public ranges are wide and vary by scope; indicative, unverified today):
   - *Auditor only, DIY evidence* — cheapest cash outlay (~US$5–15k Type I, ~$10–30k Type II) but a lot of founder time collecting evidence.
   - *Compliance-automation platform + bundled/partner auditor* (Vanta, Drata, Secureframe, Sprinto…) — commonly ~US$7–20k+/yr platform fee plus audit fees; saves time, pays off when you also need ISO 27001 or many questionnaires. Startup/discount programmes exist.
   - Cheaper-than-it-looks: scope **Security (Common Criteria) only** first; add Availability/Confidentiality later.
   - Verify current quotes: <https://www.vanta.com/pricing> · <https://drata.com/pricing> · <https://www.secureframe.com/pricing> (Checked on not re-checked).
5. Expect 6–9 months to Type I and Type II after a further observation window (`SOC2_READINESS.md`). Hosting provider reports (Hetzner/DO/OVH/Scaleway certifications) cover physical controls only.

**Penetration test:** the internal review (`docs/SECURITY_REVIEW.md`) is *not* a substitute. Cheapest options: a boutique firm or a crowdsourced/PTaaS service
(~US$4–15k for a small web app + API scope; larger for the extension/mobile), or a time-boxed freelance tester with a written scope. **Timing:** after the first deployment
is stable and before the first enterprise customer or SOC 2 observation window starts; re-test annually and after big architecture changes. Give the tester the
RLS/tenant model (`SECURITY_REVIEW.md` PP-08) and a staging copy, never production customer data. Budget for a free retest of fixes.

---

## Order of operations (cheapest first)

1. Dry-run publish → merge PR #2 (§1). 2. Domain (§2). 3. VM + `install.sh` (§3). 4. E-mail free tier + DNS records (§4). 5. Backups with an off-box copy and one restore test (§3). 6. Slack + GitHub real connects (§6). 7. Chrome + Firefox stores (§7). 8. Only then, on demand: Safari, bucket storage, bigger VM, pen test, SOC 2.

## Verification checklist before inviting users
☐ `https://$DOMAIN/health` 200 · ☐ register → verification e-mail arrives (SPF/DKIM pass) → login · ☐ create project, submit via widget and extension, see pin · ☐ screenshot opens · ☐ `backup.sh` ran, off-box copy present, restore tested · ☐ `/metrics` not public · ☐ GitHub branch protection on · ☐ MFA on GitHub, hosting, registrar, e-mail · ☐ `deploy/.env.production` saved in a password manager.
