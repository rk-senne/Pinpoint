# Pinpoint policy pack (SOC 2 starter templates)

**These are adoptable templates, not evidence and not a compliance claim.** Pinpoint is not SOC 2 compliant and has not
been audited. A policy only counts once an accountable person has adopted it, people follow it, and you can show
records that prove it (see [`../SOC2_READINESS.md`](../SOC2_READINESS.md)). Replace every `<placeholder>`; delete what
you will not do. A policy you do not follow is worse than none.

Each file has the same header: **Owner / Approver / Review cadence / Version / Effective date**. Adopt by filling
those in, getting the approver's sign-off, and committing the result (the git history is your approval record).

| # | Policy | TSC criteria it supports |
|---|---|---|
| 01 | [Information Security](01-information-security-policy.md) | CC1.1–1.5, CC2.1–2.3, CC5.1–5.3 |
| 02 | [Access Control](02-access-control-policy.md) | CC6.1–6.3, CC6.5 |
| 03 | [Change Management](03-change-management-policy.md) | CC8.1, CC5.2 |
| 04 | [Incident Response](04-incident-response-plan.md) | CC7.3–7.5, CC2.3 |
| 05 | [Business Continuity, Backup & DR](05-business-continuity-backup-dr.md) | CC9.1, CC7.5, A1.1–A1.3 |
| 06 | [Vendor Management](06-vendor-management-policy.md) | CC9.2, CC3.2 |
| 07 | [Data Retention & Deletion](07-data-retention-deletion-policy.md) | CC6.5, C1.1–C1.2 |
| 08 | [Secure Development](08-secure-development-policy.md) | CC8.1, CC7.1, CC6.8 |
| 09 | [Logging & Monitoring](09-logging-monitoring-policy.md) | CC7.1–7.3, CC4.1 |
| 10 | [Acceptable Use](10-acceptable-use-policy.md) | CC1.1, CC1.4, CC6.7–6.8 |
| 11 | [Risk Assessment & Register](11-risk-assessment-and-register.md) | CC3.1–3.4, CC4.1–4.2 |

Evidence habit (cheap, and what an auditor will ask for): keep a dated record per policy action in one folder or
ticket tracker — approvals, quarterly access review sign-offs, restore-test results, vendor reviews, incident
post-mortems. Policies without records do not pass a Type II.

What this pack deliberately does not cover: HR controls (background checks, training, onboarding/offboarding beyond the
access hooks here), physical/office security, and Privacy (GDPR) — separate tracks, listed in `SOC2_READINESS.md §5 P2`.
