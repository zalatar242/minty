'use strict';

/**
 * Pure functions for reconnect draft generation and manipulation.
 * Used by analyze.js (pre-computation) and the regenerate API endpoint (stub shuffle).
 *
 * Architecture note: Claude Code IS the AI here. The rich, personalized drafts
 * are written by Claude Code during the analyze run and stored in insights.json.
 * At runtime, the server only shuffles/remixes pre-computed text.
 */

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Convert daysSinceContact to a human time phrase for use in drafts.
 * @param {number|null} days
 * @returns {string}
 */
function daysToTimePhrase(days) {
    if (days === null || days === undefined) return 'a while';
    if (days < 7)   return 'recently';
    if (days < 21)  return 'a couple weeks';
    if (days < 60)  return 'a few months'; // "a few weeks" sounds off at 30d
    if (days < 120) return 'a couple months';
    if (days < 365) return 'a few months';
    return 'a while';
}

// ---------------------------------------------------------------------------
// Template-based draft builder (algorithmic fallback for non-analyzed contacts)
// ---------------------------------------------------------------------------

/**
 * Build a reconnect message draft from structured data.
 * Used when Claude Code hasn't written a bespoke draft.
 *
 * @param {object} contact   - Contact object from contacts.json
 * @param {object} insights  - Insights object (may be partial or null)
 * @param {string[]} recentSnippets - Array of recent message snippets (optional)
 * @returns {string}
 */
function buildReconnectTemplate(contact, insights = null, recentSnippets = []) {
    const firstName = (contact.name || 'there').split(' ')[0];
    const timePhrase = daysToTimePhrase(contact.daysSinceContact);

    // Topic reference: prefer analyzed topics, fall back to keyword extraction
    const topics = (insights && insights.topics) || [];
    const keywords = (insights && insights.keywords) || [];
    const topicRef = topics[0] || (keywords.length >= 2 ? keywords[0] + ' and ' + keywords[1] : keywords[0]) || '';

    // Open loop (first one, if any)
    const openLoops = (insights && insights.openLoops) || [];
    const openLoop = openLoops[0] || '';

    // Company / role context from LinkedIn or Apollo
    const li = (contact.sources && contact.sources.linkedin) || {};
    const apollo = contact.apollo || {};
    const company = li.company || apollo.currentCompany || '';

    const sentences = [];

    // Opening: personal, time-aware, specific topic if available
    if (topicRef) {
        sentences.push(
            `Hey ${firstName}, it's been ${timePhrase} — I was thinking about our conversation around ${topicRef} and wanted to reach out.`
        );
    } else if (recentSnippets.length > 0) {
        // Extract a usable phrase from the most recent message
        const words = (recentSnippets[0] || '')
            .split(/\s+/).filter(w => w.length > 4).slice(0, 4).join(' ');
        if (words) {
            sentences.push(`Hey ${firstName}, it's been ${timePhrase} — thinking about you after "${words}" came to mind.`);
        } else {
            sentences.push(`Hey ${firstName}, it's been ${timePhrase} — I was thinking about you and wanted to check in.`);
        }
    } else {
        sentences.push(`Hey ${firstName}, it's been ${timePhrase} — I was thinking about you and wanted to reach out.`);
    }

    // Company context line (if we know where they work)
    if (company) {
        sentences.push(`Hope things are going well at ${company}.`);
    }

    // Open loop follow-up
    if (openLoop) {
        // Strip leading clauses like "Asked him to...", "She's applying..." etc.
        const loopCore = openLoop
            .split('—')[0]
            .replace(/^(Asked|Mentioned|Confirmed|Helped|She's|He's|Pending|We were going to)\s+/i, '')
            .replace(/^(him|her|you)\s+(to\s+)?/i, '')
            .trim()
            .toLowerCase();
        if (loopCore.length > 4) {
            sentences.push(`Also wanted to follow up on ${loopCore} — did that ever work out?`);
        }
    }

    // Close
    sentences.push(`Would love to catch up — are you up for a coffee or a quick call sometime soon?`);

    return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Regenerate helpers (stub — real regeneration happens in next Ralph run)
// ---------------------------------------------------------------------------

/**
 * Shuffle the middle sentences of a draft, keeping the first and last intact.
 * This is the stub "regenerate" used at runtime.
 * Real regeneration (better Claude-written draft) happens in the next analyze run.
 *
 * @param {string} draft
 * @returns {string} modified draft (or original if too short to shuffle)
 */
function shuffleSentences(draft) {
    // Match sentence-ending tokens; keep surrounding whitespace
    const sentences = draft.match(/[^.!?]+[.!?]+\s*/g) || [draft];
    if (sentences.length <= 2) return draft;

    const first = sentences[0];
    const last  = sentences[sentences.length - 1];
    const middle = sentences.slice(1, -1);

    if (middle.length === 0) return draft;

    // Rotate middle: push first-middle to the back
    if (middle.length > 1) {
        middle.push(middle.shift());
    }

    return [first, ...middle, last].join('').trim();
}

/**
 * Reframe the opening sentence with an alternative tone.
 * Used as fallback when shuffleSentences produces no change (e.g. only 2 sentences).
 *
 * @param {string} draft
 * @param {string} firstName
 * @returns {string}
 */
function alternateOpener(draft, firstName) {
    const name = firstName || 'there';
    const openers = [
        `Hi ${name}! I've been meaning to reach out — `,
        `${name}! It's been too long. `,
        `Hey ${name}, hope things are good — `,
    ];
    // Deterministic selection so repeated calls cycle through
    const idx = (draft.length + name.length) % openers.length;
    // Replace first sentence with alternative opener + rest of draft
    const rest = draft.replace(/^[^.!?]+[.!?]+\s*/, '').trim();
    const opener = openers[idx];
    return rest ? `${opener}${rest}` : opener.trim() + '.';
}

/**
 * Produce a "regenerated" version of a draft.
 * Tries shuffling first; if that produces no change, tries alternateOpener.
 *
 * @param {string} draft
 * @param {string} firstName
 * @returns {string}
 */
function regenerateDraft(draft, firstName) {
    const shuffled = shuffleSentences(draft);
    if (shuffled !== draft) return shuffled;
    return alternateOpener(draft, firstName);
}

module.exports = {
    daysToTimePhrase,
    buildReconnectTemplate,
    shuffleSentences,
    alternateOpener,
    regenerateDraft,
};
