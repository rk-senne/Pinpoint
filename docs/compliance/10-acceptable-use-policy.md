# 10 — Acceptable Use Policy

| Owner | Approver | Review cadence | Version | Effective |
|---|---|---|---|---|
| `<security owner>` | `<management>` | Annual; acknowledged by every person on joining and annually | `0.1 draft` | `<date>` |

Template — not adopted until filled and approved. No compliance claim.

## 1. Scope
Everyone (staff, contractors) using `<Company>` systems, accounts, devices, or customer data.

## 2. Rules
1. **Devices:** full-disk encryption on, screen lock ≤ 5 min, OS and browser auto-updates on, no shared use, lost/stolen device reported within 24 h ([04](04-incident-response-plan.md)). Personal devices only if they meet the same baseline `<or: company devices only>`.
2. **Accounts:** a password manager; unique long passwords; MFA everywhere it exists ([02](02-access-control-policy.md)); never share credentials or reuse them.
3. **Customer data:** use only to deliver and support the service. Do not copy production data (including screenshots, session replays, console/network captures, guest e-mails) to personal storage, chat, e-mail or AI tools. Support access needs the customer's consent and a ticket.
4. **Secrets:** never paste secrets in git, tickets, chat or AI assistants; `deploy/.env.production` stays on the host/vault.
5. **Code and AI tools:** only approved tools; do not send customer data or secrets to third-party services; review generated code like any other code ([08](08-secure-development-policy.md)).
6. **Software:** install only from official sources; no pirated software; no disabling endpoint protection.
7. **Network:** use trusted networks or a VPN for production access; never expose the Vite dev server or internal ports to the internet.
8. **Prohibited:** accessing data you are not authorised for, probing customer environments without written consent, bypassing controls (branch protection, the boot preflight, RLS), harassment or illegal content.
9. **Reporting:** report phishing, suspected compromise or policy breaches immediately to `security@<domain>`.
10. **Offboarding:** return devices, remove company data from personal devices, access ends ([02 §3](02-access-control-policy.md)).

## 3. Monitoring and enforcement
Company systems may be monitored as the law allows. Breaches can lead to access removal and disciplinary action `<per HR policy>`.

## 4. Acknowledgement
I have read and agree: `<name>` · `<date>` · (keep signed/clicked record `<location>`).
