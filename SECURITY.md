# Security policy

## Supported versions

Pinpoint is self-hosted and released from `main`. Security fixes go to the
latest `main` and the `latest` images on GHCR; upgrade with
`deploy/upgrade.sh`. Older commits are not patched.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
**Security → Report a vulnerability** on
<https://github.com/rk-senne/Pinpoint/security/advisories/new>.

Include affected version/commit, steps to reproduce, and impact. We aim to:

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix for Critical / High | 30 days |
| Fix for Medium / Low | 90 days |

We credit reporters in the advisory unless you ask us not to. Please give us
reasonable time to release a fix before public disclosure. Good-faith research
that respects user privacy, avoids service degradation and does not access
other people's data is welcome; we will not pursue legal action for it.

## What is in place

Free, automated controls on every pull request (`.github/workflows/security.yml`,
`ci.yml`): CodeQL, Semgrep CE, gitleaks (full history), npm audit, OSV-Scanner,
Trivy (filesystem, IaC and both container images), an OWASP ZAP baseline scan
of the production stack, and OpenSSF Scorecard on `main`. GitHub secret
scanning with push protection, Dependabot alerts and security updates, and
private vulnerability reporting are enabled. Design-level controls and the
internal review are in [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md).
