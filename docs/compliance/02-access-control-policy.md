# 02 — Access Control Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner>` | `<management>` | Annual; access reviews **quarterly** | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. Scope
Access to: the production host(s) (SSH), the database, `deploy/.env.production`, GitHub org/repo and Actions secrets,
GHCR, the DNS/registrar and hosting accounts, SMTP/storage vendor consoles, and customer-facing admin functions in Pinpoint
itself (org owners/admins).

## 2. Rules
1. **Unique accounts, no sharing.** Every person has their own GitHub, hosting-console and SSH key. No shared root logins.
2. **MFA mandatory** on GitHub, the hosting provider, the registrar, the SMTP/storage vendors and e-mail. Prefer hardware keys for the production host and registrar. (Pinpoint itself has no customer MFA yet — see risk R-04.)
3. **SSH:** key-only (`PasswordAuthentication no`), root login disabled, firewall limited to 22/80/443 (`deploy/install.sh` enables `ufw`); restrict 22 to known IPs/VPN where practical.
4. **Least privilege:** GitHub write access only for engineers; repository admin and Actions-secret access for `<2>` named people. Database access via the `pinpoint_app` role for the application; owner credentials (`DB_MIGRATION_USER`) only for migrations and break-glass admin.
5. **Production access** is granted by the Engineering lead, recorded in the access register `<location>` with person, system, level, date, approver.
6. **Secrets handling:** the holders of `deploy/.env.production` are listed in the register. Rotate `JWT_SECRET`/`DB_*` on departure of a holder with access; `INTEGRATION_ENCRYPTION_KEY` rotation requires re-encrypting stored tokens (plan first).
7. **Customer accounts:** org roles (`owner`/`admin`/`member`/`viewer`) are enforced by the application; `<Company>` staff access customer data only for support with the customer's consent, logged in the ticket.

## 3. Joiner / mover / leaver
- **Joiner:** ticket with access list and approver; MFA verified before grant.
- **Mover:** remove access no longer needed within 5 working days.
- **Leaver:** all access removed **within 24 hours** of departure: GitHub org, hosting console, SSH `authorized_keys`, vendor consoles, password-manager vaults; rotate shared secrets they held. Record in the ticket.
- For Pinpoint customer orgs, removing a member (`DELETE /api/v1/org/members/:id`) bumps `token_version`, revokes their API keys and disconnects their realtime sockets.

## 4. Quarterly access review (procedure)
Reviewer: Security owner (not reviewing their own access — a second person reviews it). Within 10 working days of each quarter end:

1. **GitHub:** export org members and outside collaborators with roles; export deploy keys, Actions secrets list (names only) and GitHub Apps/OAuth apps. Confirm each is current staff with a justified role.
2. **Production host:** list `~/.ssh/authorized_keys` of each login user and `getent group sudo docker`; map each key to a person. Remove unknown/stale keys.
3. **Database/secrets:** list who knows `deploy/.env.production` and the DB owner credentials; confirm against the register.
4. **Vendor consoles:** hosting, registrar, SMTP, storage, Stripe (if used), monitoring — list users and roles.
5. **Pinpoint's own org** (the one used for `<Company>` operations): list members via `GET /api/v1/org/members` and review role changes in the audit log: `GET /api/v1/org/audit-log?actionPrefix=member.` plus `actionPrefix=api_key.` and `actionPrefix=auth.` (admin role required). Confirm every owner/admin change and every API-key creation is explained, and revoke stale API keys.
6. Record: date, reviewer, systems covered, items removed, sign-off. Keep the artefacts (exports/screenshots) as evidence in `<location>`.

Note: the audit log is append-only at the DB level (trigger) but a DB superuser can disable the trigger — ship it off-host for stronger evidence (risk R-09).

## 5. Exceptions and break-glass
Emergency access is granted by the Security owner, logged, and reviewed within 5 working days.

## 6. Sign-off
Approved by `<name>` on `<date>`.
