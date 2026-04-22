# Contact Matching Strategy for Claude Code

This document tells Claude Code exactly how to identify and link the same person
across WhatsApp, LinkedIn, Telegram, and Email in a repeatable way.

Run this whenever new data has been imported from any source.

---

## Step 0 — Understand the data

Read the unified contacts file:
```
data/unified/contacts.json
```

Each contact looks like:
```json
{
  "id": "c_0042",
  "name": "Alex Patel Uni CS",
  "phones": ["+15551234567"],
  "emails": [],
  "sources": {
    "whatsapp": { "name": "Alex Patel Uni CS", "number": "15551234567", ... },
    "linkedin": null,
    "telegram": null,
    "email": null
  }
}
```

Contacts where only one source is non-null are candidates for cross-matching.

---

## Step 1 — Find candidates

Load `data/unified/contacts.json` and split into groups by source:
- `wa_only`  → `sources.whatsapp != null && sources.linkedin == null`
- `li_only`  → `sources.linkedin != null && sources.whatsapp == null`
- (repeat for telegram, email when available)

**Blocking rule:** For each `wa_only` contact, extract the first word of the name
(lowercased). Find all `li_only` contacts whose name also starts with that same word.
These are your candidate pairs — typically 100–400 pairs total.

---

## Step 2 — Recognise WhatsApp nickname patterns

WhatsApp contacts are often saved with context suffixes. Strip these before matching:

| Pattern | Example | Cleaned |
|---|---|---|
| `Name Institution Course` | `Alex Patel Uni CS` | `Alex Patel` |
| `Name Institution` | `Sam Uni` | `Sam` |
| `Name City` | `Jordan Dubai` | `Jordan` |
| `Name Company` | `Taylor Acme` | `Taylor` |
| `Nickname` (single word) | `Robin` | `Robin` |

Heuristic: if the name has 3+ words and the last 1–2 words are all-caps or known
institution abbreviations (UCL, MIT, LSE, NYU, IIT, etc.), strip them.

---

## Step 3 — Score each candidate pair

For each candidate pair (one WhatsApp, one LinkedIn), reason over these signals:

| Signal | Weight | Notes |
|---|---|---|
| Cleaned first name exact match | High | Case-insensitive |
| Last name match (after cleaning) | High | Fuzzy ok — "Micheletti" vs "Micheletti 宁远" |
| Phone country code matches LinkedIn location | Medium | +44 → UK, +91 → India, etc. |
| LinkedIn company matches WhatsApp suffix | Medium | "Revolut" in WA name + Revolut on LinkedIn |
| LinkedIn position matches context | Low | "UCL CS" → student at UCL → LinkedIn shows UCL |
| First name is very common (Ali, James, Sara) | Negative | Lower confidence without corroborating signal |

Classify each pair as:
- `"confirmed"` — high confidence, merge automatically (≥2 strong signals)
- `"likely"` — merge automatically but flag for review (1 strong + 1 medium)
- `"possible"` — write to file but DO NOT auto-merge, needs human review
- `"skip"` — clearly different people

---

## Step 4 — Write the overrides file

Write matches to `data/unified/match_overrides.json`:

```json
[
  {
    "confidence": "confirmed",
    "ids": ["c_0042", "c_1837"],
    "reason": "First name 'Alex' matches after stripping Uni CS suffix; phone country code matches LinkedIn location; company on LinkedIn matches engineering context",
    "sources_linked": ["whatsapp", "linkedin"]
  },
  {
    "confidence": "possible",
    "ids": ["c_0105", "c_2341"],
    "reason": "First name matches but it's a very common name; no other corroborating signals",
    "sources_linked": ["whatsapp", "linkedin"]
  }
]
```

**Important:** Always write a human-readable `reason`. This lets the user audit and
correct matches later.

---

## Step 5 — Re-run the merge

After writing overrides, run:
```bash
node crm/merge.js
```

`merge.js` reads `match_overrides.json` and force-links those contact pairs before
doing the normal deduplication pass. Contacts with `"possible"` confidence are listed
in the stats but not merged until the user approves them.

---

## How merge.js uses overrides

`merge.js` does this before the normal merge:
1. Loads `data/unified/match_overrides.json`
2. For `"confirmed"` and `"likely"` entries: merges both contacts into the same unified record
3. For `"possible"` entries: skips the merge (needs human review via `npm run review`)
4. Prints a summary of how many overrides were applied

---

## Step 6 — Iterate

After adding Telegram or Email:
1. Run the relevant importer (`npm run telegram` / `npm run email`)
2. Run `node crm/merge.js` to get fresh unified contacts
3. Re-run this matching process for the new source vs existing sources
4. Append new matches to `match_overrides.json` (don't overwrite — existing matches stay)

---

## Repeatable invocation

Tell Claude Code:
> "Follow crm/MATCHING.md to find cross-source contact matches"

Claude Code will:
1. Read the unified contacts
2. Block by first name
3. Reason over candidates
4. Write/update `data/unified/match_overrides.json`
5. Run `node crm/merge.js`

---

## Known nickname patterns in this dataset

Observed so far (update this as new patterns emerge):
- `{Name} {Uni} {Course}` — e.g. met at a university for a specific course
- `{Name} {Uni}` — met at a university (course unknown)
- Names with CJK characters appended: e.g. `Alex Rivera 山田` — the CJK name is an alias, strip for matching
