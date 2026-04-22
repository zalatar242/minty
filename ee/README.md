# ee/ — Enterprise Features

This directory is **reserved for future proprietary features** (e.g. SSO/SAML, team admin, audit logs, multi-tenant hosting). It is intentionally empty for v0.1.

## Licensing

Unlike the rest of Minty (AGPL-3.0), code that lands in this directory will be released under a **separate commercial license**. Contributions to `ee/` are not accepted via the public repo.

This mirrors the pattern used by PostHog, Dub, Formbricks, and other open-core projects: the core (`crm/`, `sources/`) stays fully open-source and self-hostable forever, while select enterprise-oriented features live here under a commercial license.

## Why this split

- **The free self-hosted product stays complete.** You can run Minty forever without ever touching `ee/`. Feature parity for individuals is the priority.
- **Contributor clarity.** Community contributions land in AGPL-3.0 code, not proprietary code. No CLA, no relicensing surprises.
- **Commercialization without rugpull.** If Minty builds a hosted offering, the proprietary pieces live here from day one — not added retroactively by relicensing your contributions.

## Questions

If you think a feature belongs in `ee/` vs. the open-source core, open an issue. The default answer is "open source" — `ee/` is reserved for features that specifically serve organizations paying for hosted Minty.
