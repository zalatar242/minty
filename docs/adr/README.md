# Architecture Decision Records

Lightweight log of significant technical decisions. Each ADR captures the **context**, the **options considered**, the **decision**, and the **consequences** — so future maintainers (and the original author six months later) can understand *why* the codebase looks the way it does.

We follow Michael Nygard's [original lightweight ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), with a `Status · Date · Author` header line.

## When to write one

Write an ADR when the decision:

- Is **hard to reverse** (e.g. choice of WhatsApp library, the unified-store schema, AGPL vs MIT)
- Has **tradeoffs that aren't obvious from the code** (e.g. why we use `whatsapp-web.js` instead of Baileys)
- **Constrains future work** (e.g. "no TypeScript", "no cloud-LLM in core")
- Is the result of a **scope or product disagreement** that someone might re-litigate

If a decision is reversible in an afternoon, you don't need an ADR.

## How to write one

1. Pick the next number: `NNNN-kebab-case-title.md` (e.g. `0002-unified-store-format.md`).
2. Copy the structure from `0001-whatsapp-library.md`:
   - `# ADR NNNN: <Title>`
   - `**Status:** Proposed | Accepted | Superseded by ADR-NNNN · **Date:** YYYY-MM-DD · **Author:** <name>`
   - `## Context` — what's true about the world that forces this decision?
   - `## Decision drivers` — the criteria used to compare options
   - `## Options` — at least two; "do nothing" is often a valid option
   - `## Decision` — what we picked, in one paragraph
   - `## Consequences` — positive, negative, and follow-up work
3. Open a PR. Discussion happens in the PR; the ADR captures the outcome, not the debate.

## Status lifecycle

- **Proposed** — drafted, in discussion
- **Accepted** — merged; the decision is in effect
- **Superseded by ADR-NNNN** — replaced by a newer decision; keep the old ADR as historical record, link forward

Never delete an ADR. Mark it superseded and link forward.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](./0001-whatsapp-library.md) | WhatsApp Library Choice — `whatsapp-web.js` vs Baileys | Proposed |
