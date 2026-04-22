# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Instead, report privately via GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/zalatar242/minty/security) of this repository
2. Click **Report a vulnerability**
3. Fill out the form

Alternatively, email `security@minty.dev` (once the domain is set up — until then, use GitHub's private advisory flow above).

## What to include

- A description of the issue and why it's a vulnerability
- Steps to reproduce
- The affected version / commit SHA
- Your assessment of severity and impact
- Any suggested fix (optional)

## Response expectations

Minty is maintained by a solo developer. Best-effort response times:

- **Acknowledgement**: within 7 days
- **Initial assessment**: within 14 days
- **Fix or mitigation**: timeline depends on severity

## Scope

In scope:
- The `crm/` server and web UI
- The data importers under `sources/`
- Any injection, XSS, RCE, path traversal, or data exfiltration issue
- Dependency vulnerabilities that are exploitable through Minty's code paths

Out of scope:
- Issues that require local filesystem or shell access (Minty is self-hosted — local access is assumed)
- Vulnerabilities in third-party services (WhatsApp Web, IMAP, Google, LinkedIn) — report those to the vendor
- Social engineering

## Disclosure

We prefer coordinated disclosure. Please give us a reasonable window to ship a fix before publishing details. We'll credit you in the changelog unless you prefer to remain anonymous.
