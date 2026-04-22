# Changelog

All notable changes to Minty will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - TBD

Initial public release.

### Added
- Web UI at `localhost:3456` (`npm run crm`) — contact list, contact detail, match review
- Importers: WhatsApp, LinkedIn, Telegram, Email (IMAP), Google Contacts, SMS, Apollo enrichment
- Cross-source dedup and merge engine (`crm/merge.js`)
- Matching engine with stable ID derivation (`crm/match.js`)
- CLI query tools (`npm run stats`, `npm run search`)
- Match review server (`npm run review`)

[Unreleased]: https://github.com/zalatar242/minty/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zalatar242/minty/releases/tag/v0.1.0
