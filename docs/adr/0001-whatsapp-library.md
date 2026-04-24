# ADR 0001: WhatsApp Library Choice — `whatsapp-web.js` vs Baileys

**Status:** Proposed · **Date:** 2026-04-23 · **Author:** sree (with Claude)

## Context

Minty uses `whatsapp-web.js@1.34.6` to read a user's own WhatsApp data (contacts, chats, group rosters, messages). Two production issues emerged:

1. **`chat.fetchMessages()` is broken.** Crashes on `Cannot read properties of undefined (reading 'waitForChatLoading')`. Internal WhatsApp Web DOM method the library reaches into has been renamed or removed upstream. Every historical-message fetch fails. Live message listener still works.
2. **History sync is not a first-class API.** Library has `client.syncHistory(chatId)` (calls `Store.HistorySync.sendPeerDataOperationRequest`) but it's speculative — fires a peer-data request and hopes messages arrive via the message event. No deterministic way to know when backfill completes or verify coverage.

This blocks the "relationship score from DM frequency" and "historical signal extraction" features on `ROADMAP.md`, and forces Minty to build ranking on incomplete data until either (a) the library fixes the upstream method, or (b) we switch libraries.

Both the `/autoplan` Codex and Claude-subagent CEO reviews flagged dismissing Baileys as a critical error and required an ADR before investing more in `pupPage.evaluate` workarounds.

## Decision drivers

- **History reliability** — Can we download the past 3-5 years of messages deterministically?
- **Group metadata completeness** — Participant lists with admin flags, owner, creation timestamps, descriptions, labels.
- **Ban risk** — Probability of WhatsApp locking the user's account.
- **Maintenance burden** — How often does upstream change break us?
- **Migration cost** — Line-count + user-friction to switch.
- **Resource footprint** — Minty is self-hosted on a user's laptop. Fewer deps = better.

## Options

### Option A: Stay on `whatsapp-web.js` + workarounds (Track C from the plan)

Live with broken `fetchMessages`. Attempt three mitigations:
- `client.syncHistory(chatId)` — speculative; unknown yield.
- `client.searchMessages(query)` — works on whatever's in the live store but requires the store to have been seeded.
- Direct `pupPage.evaluate` against `window.Store.Msg.getModelsArray()` — bypass the library wrapper; scrape the Chromium process.

**Pros:**
- Zero migration. `crm/server.js`, `sources/whatsapp/export.js`, `crm/sync.js` untouched.
- Live sync is already working (post-PR #9 fix).

**Cons:**
- Three speculative paths each with unknown yield. Plan allocates 1.25 days CC across them; both reviewers called it "speculative library archaeology" and "hidden maintenance debt."
- Each workaround depends on WhatsApp Web DOM internals. WhatsApp ships Web updates every ~2 weeks. Every update is a risk of re-breaking.
- Even when messages flow, there's no clean API contract — we're reaching into a Puppeteer-exposed internal store.
- Browser + Chromium process overhead (~300 MB RAM) for something that's fundamentally a protocol client.

### Option B: Switch to Baileys (`@whiskeysockets/baileys`)

WebSocket-based direct protocol client. No browser. Native TypeScript.

**Key capabilities verified via Context7 + official docs:**

| Feature | Baileys API | Status |
|---|---|---|
| Full history sync | `syncFullHistory: true` + `Browsers.macOS('Desktop')` | Documented, first-class |
| Group rosters (all groups) | `sock.groupFetchAllParticipating()` | One call, returns keyed object |
| On-demand history backfill | `sock.fetchMessageHistory(50, lastMsg.key, ts)` | Max 50 per call, paginated |
| Live message events | `sock.ev.on('messages.upsert')` | Event-driven |
| Group participant changes | `sock.ev.on('group-participants.update')` | Real-time deltas |
| Profile picture | `sock.profilePictureUrl(jid, 'image')` | URL (hi-res optional) |
| Contact status/about | `sock.fetchStatus(jid)` | Direct API |
| Business profile | `sock.getBusinessProfile(jid)` | Richer than wweb.js |
| Presence (online/offline) | `sock.presenceSubscribe(jid)` + `presence.update` event | Real-time |
| Auth persistence | `useMultiFileAuthState('auth_info_baileys')` | Clean pattern |
| Register new device | Pairing code OR QR | Flexible |

**`messaging-history.set` event** fires on connect with `{ chats, contacts, messages, isLatest }` — this is the native "download everything" mechanism that the whole Track C rabbit hole is trying to reinvent.

**Pros:**
- **History sync is a first-class primitive.** Not a hope, not a hack. Set a flag, listen to one event, get everything.
- Smaller footprint (no Chromium / Puppeteer): ~50-100 MB less RAM, faster startup.
- Active maintenance. `/whiskeysockets/baileys` on Context7: high source reputation, 78+ benchmark score, 129 code snippets.
- WebSocket protocol is more stable than WhatsApp Web DOM internals. WhatsApp updates the Web UI frequently but the underlying message protocol changes far less often.
- TypeScript native. Minty is `"type": "commonjs"`, so we'd use the `.js` build or require-interop — not zero friction but fine.
- Richer presence + event model. Useful for future features (real-time "is this person online").

**Cons:**
- **Migration work.** ~400 lines across `sources/whatsapp/export.js` + `crm/server.js runWhatsAppExport` + `crm/sync.js attachWhatsAppSync` need rewriting. Estimate: 1-2 days CC + testing.
- **Users re-pair.** `.wwebjs_auth` state doesn't port. Every Minty user scans a QR once.
- **Auth-store incompatibility window.** If we ship as a default, existing users lose live-sync until they re-pair.
- **TypeScript/ESM friction.** Baileys is TS+ESM, Minty is CJS. Interop is well-trodden but adds a `require('@whiskeysockets/baileys').default` or `await import()` pattern.
- **Ban risk equivalence.** Both are unofficial. Baileys' own disclaimer calls out personal responsibility; reports of bans correlate with bulk messaging and automation, not personal read-only use. Same risk profile as today.

### Option C: Dual-adapter (both at once)

Keep `whatsapp-web.js` for the existing live-sync path. Add Baileys as an opt-in "historical backfill" run: user runs `npm run whatsapp-backfill`, scans a second QR in Baileys' auth store, Baileys downloads history via `syncFullHistory`, writes to `data/whatsapp/chats.json`, exits. wweb.js continues handling live messages.

**Pros:**
- Zero regression for existing users. Live sync keeps working as-is.
- Clean split: wweb.js = real-time listener, Baileys = batch history.
- Gives us concrete data to decide whether to fully migrate later.

**Cons:**
- Two auth stores, two QR scans, two WhatsApp "linked devices" slots used.
- Doubles the code surface. Both libraries' bugs are our bugs.
- Schema merge complexity: Baileys' message shape ≠ wweb.js' message shape; both land in `chats.json` and the merge logic has to normalize.
- Slightly higher ban risk from two concurrent sessions? (Unverified; both count as "linked devices" which WhatsApp caps at 4 per account.)

## Recommendation

**Option C (dual-adapter) for the next cycle, with an explicit plan to collapse to Option B within 2 milestones if Baileys proves reliable.**

Reasoning:
1. Option A is the worst of the three — speculative workarounds against a known-broken path. Both reviewers rejected it. Don't build around `pupPage.evaluate`.
2. Option B is the right long-term answer. Baileys' API is objectively better matched to Minty's job-to-be-done ("read my own WhatsApp data deterministically").
3. But Option B alone means the user's existing live-sync stops until they re-pair, and any Baileys bug becomes a zero-alternative blocker. For a tool the user dogfoods daily, that's too much risk for a single cycle.
4. Option C lets us ship Baileys-backed history **additively** — a `npm run backfill-baileys` that runs once, writes files, exits, doesn't disturb the live listener. If Baileys comes back with years of clean history, the next cycle removes wweb.js entirely. If it has unexpected issues, we're no worse off than today.

## Implementation sketch (Option C)

### Phase 1: prove Baileys works (half a day CC)

New file: `sources/whatsapp/baileys-backfill.js`
```js
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

async function run() {
    const authDir = path.join(__dirname, '../../.wwebjs_auth_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS('Desktop'),  // unlocks more history
        syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ qr, connection }) => {
        if (qr) console.log('Scan QR (printed below). Fresh pairing — separate from your existing Minty session.');
        if (connection === 'open') console.log('Connected. Waiting for history sync…');
    });

    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        // Write incrementally; messages arrive in batches
        const outPath = path.join(__dirname, '../../data/whatsapp/baileys-history.json');
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
        existing.chats = [...(existing.chats || []), ...chats];
        existing.messages = [...(existing.messages || []), ...messages];
        fs.writeFileSync(outPath, JSON.stringify(existing));
        console.log(`[baileys] +${chats.length} chats, +${messages.length} messages. latest=${isLatest}`);
        if (isLatest) {
            // Also fetch all group metadata in one call
            const groups = await sock.groupFetchAllParticipating();
            fs.writeFileSync(path.join(__dirname, '../../data/whatsapp/baileys-groups.json'),
                JSON.stringify(groups, null, 2));
            console.log('History sync complete. Exiting.');
            sock.end(undefined);
            process.exit(0);
        }
    });
}

run();
```

Add to `package.json`: `"backfill-baileys": "node sources/whatsapp/baileys-backfill.js"`.

Run once, observe:
- How many messages arrive in `messaging-history.set`?
- How long does full history take (expect: 5-30 minutes for a 5-year-old account)?
- Does the account get rate-limited?

### Phase 2: normalize into merge.js (half a day CC)

New function in `crm/merge.js`: `loadBaileysHistory()` reads `data/whatsapp/baileys-history.json` + `data/whatsapp/baileys-groups.json`, normalizes to the existing unified interaction schema (`createInteraction('whatsapp', ...)`), and appends to the interactions list.

Baileys groups come keyed by JID (`"120363...@g.us"`). Convert to our existing `chats.json` shape: `{ [chatName]: { meta: { participants: [...] }, messages: [...] } }` for consistency, OR keep separate and teach `buildInteractions` to read both sources.

### Phase 3: decide — keep or collapse (sometime later)

After 1-2 weeks of dual operation, assess:
- Did Baileys' history sync deliver meaningful data that wweb.js couldn't?
- Did either library cause a WhatsApp ban / lock?
- Did the user's workflow improve?

If yes: write follow-up ADR proposing full migration to Baileys (Option B). Estimated additional work: 1 day CC to port live-sync, 1 day to deprecate wweb.js.

If no: keep the dual setup or revert. No code debt beyond the two files added.

## Consequences

**If we proceed with Option C as outlined:**

- ✅ Historical messages become accessible (the primary blocker).
- ✅ `data/whatsapp/baileys-history.json` becomes a rich dataset for ranking, signal extraction, DM-frequency scoring.
- ✅ Zero regression for the existing Minty workflow — wweb.js live listener untouched.
- ✅ Gives us empirical data to make the Option B decision properly.
- ⚠️ One-time user friction: re-scan QR in Baileys. One terminal command, ~10 seconds of user time.
- ⚠️ New npm dep (`@whiskeysockets/baileys` is large — ~1 MB tree). Minty's `README.md` "minimal dependencies" ethos gets slightly compromised.
- ⚠️ Second WhatsApp "Linked Devices" slot consumed. WhatsApp caps at 4; user needs to have a slot free.
- ⚠️ Any library-level breakage in Baileys is our problem for the new path, same as wweb.js.

**What we're NOT doing:**
- Not pursuing Track C (`pupPage.evaluate` workarounds) from the original plan.
- Not migrating off wweb.js in this cycle. Dual-adapter only.
- Not exposing new user-facing features that depend on historical messages until Phase 1 has measured yield.

## Open questions to resolve before Phase 1

1. Baileys is ESM/TypeScript. Minty is CJS. Quickest interop pattern for this project?
   - Option: `const { default: makeWASocket } = require('@whiskeysockets/baileys')` (works with a recent dynamic-require setup; verify on Node 20).
2. Does `syncFullHistory: true` return messages from *all* chats or just chats explicitly opened? (Docs say full; actual behavior may depend on WhatsApp-side "linked devices" history retention.)
3. What happens if WhatsApp already synced history to wweb.js's session? Does Baileys re-fetch everything or does the user-server side dedupe?

These are empirical — Phase 1 answers them in ~half a day.

## Next action

Approve this ADR. I'll ship Phase 1 as a small isolated PR (`baileys-backfill.js` + `package.json` script + README note). Run once against the user's real WhatsApp. Report yield. Decide on Phase 2 from there.
