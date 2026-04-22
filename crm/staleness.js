/**
 * crm/staleness.js — Data freshness and staleness detection
 *
 * Pure functions for detecting stale data sources, generating user-facing
 * warnings, and computing per-contact data confidence levels.
 *
 * Used by:
 *   - GET /api/staleness   — overall staleness summary
 *   - GET /api/today       — syncWarnings injected into home view response
 *   - Contact list         — per-contact confidence indicator
 */

'use strict';

// Days until a source is considered stale
const SOURCE_THRESHOLDS = {
    whatsapp:      1,    // Real-time expected — stale after 1 day
    email:         1,    // Polls every 10 min — stale after 1 day
    googleContacts: 2,   // Polls every 30 min — stale after 2 days
    calendar:      1,    // Polls every 15 min — stale after 1 day
    linkedin:      30,   // Manual export — stale after 30 days
    telegram:      30,   // Manual export — stale after 30 days
    sms:           30,   // Manual export — stale after 30 days
};

// Primary sources (real-time/polling) — missing sync is more urgent
const PRIMARY_SOURCES = ['whatsapp', 'email'];

// File-based sources — expected to be manually refreshed
const FILE_SOURCES = ['linkedin', 'telegram', 'sms'];

const SOURCE_LABELS = {
    whatsapp:       'WhatsApp',
    email:          'Gmail',
    googleContacts: 'Google Contacts',
    calendar:       'Calendar',
    linkedin:       'LinkedIn',
    telegram:       'Telegram',
    sms:            'SMS',
};

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Days since an ISO timestamp, or null if never synced.
 * Returns 0 for future timestamps.
 */
function daysSince(lastSyncAt, now = Date.now()) {
    if (!lastSyncAt) return null;
    const ms = now - new Date(lastSyncAt).getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Hours since an ISO timestamp, or null if never synced.
 */
function hoursSince(lastSyncAt, now = Date.now()) {
    if (!lastSyncAt) return null;
    const ms = now - new Date(lastSyncAt).getTime();
    return Math.max(0, Math.floor(ms / (1000 * 60 * 60)));
}

/**
 * Returns true if lastSyncAt is older than thresholdDays.
 * null lastSyncAt → never synced → returns false (not stale, just unset).
 */
function isSourceStale(lastSyncAt, thresholdDays, now = Date.now()) {
    const days = daysSince(lastSyncAt, now);
    if (days === null) return false;
    return days > thresholdDays;
}

// ---------------------------------------------------------------------------
// Staleness summaries
// ---------------------------------------------------------------------------

/**
 * Returns an array of stale source entries from a sync state object.
 * Each entry: { source, label, daysSince, thresholdDays }
 *
 * Only returns sources that exist in syncState AND are known sources.
 * Never-synced sources (null lastSyncAt) are excluded — they're "not set up", not "stale".
 */
function getStaleSources(syncState, now = Date.now()) {
    if (!syncState || typeof syncState !== 'object') return [];

    return Object.entries(SOURCE_THRESHOLDS)
        .filter(([source]) => syncState[source])
        .map(([source, thresholdDays]) => {
            const src = syncState[source] || {};
            const days = daysSince(src.lastSyncAt, now);
            const stale = days !== null && days > thresholdDays;
            return { source, label: SOURCE_LABELS[source] || source, daysSince: days, thresholdDays, stale };
        })
        .filter(entry => entry.stale);
}

/**
 * Returns warnings for primary sources (WhatsApp, Gmail) not synced in > 24 hours.
 * Only warns if the source HAS been synced before (lastSyncAt is set).
 * Each warning: { source, label, message, severity: 'warning'|'error', ageHours }
 */
function getPrimarySourceWarnings(syncState, now = Date.now()) {
    if (!syncState || typeof syncState !== 'object') return [];

    const warnings = [];
    for (const source of PRIMARY_SOURCES) {
        const src = syncState[source] || {};
        if (!src.lastSyncAt) continue; // Never synced — not connected yet, don't warn

        const ageHours = hoursSince(src.lastSyncAt, now);
        if (ageHours === null || ageHours <= 24) continue;

        const label = SOURCE_LABELS[source] || source;
        let ageText;
        if (ageHours >= 48) {
            ageText = `${Math.floor(ageHours / 24)} days`;
        } else {
            ageText = `${ageHours} hours`;
        }

        warnings.push({
            source,
            label,
            message: `${label} hasn't synced in ${ageText} — check connection`,
            severity: ageHours >= 72 ? 'error' : 'warning',
            ageHours,
        });
    }
    return warnings;
}

/**
 * Human-readable staleness message for a source.
 */
function getStalenessMessage(source, days) {
    const label = SOURCE_LABELS[source] || source;
    if (days === null) return `${label} has never synced`;
    if (days === 0) return `${label} synced today`;
    if (days === 1) return `${label} synced yesterday`;
    if (days <= 7) return `${label} synced ${days} days ago`;
    if (days <= 30) return `${label} export is ${days} days old — refresh?`;
    return `${label} export is ${days} days old — data may be outdated`;
}

// ---------------------------------------------------------------------------
// Per-contact data confidence
// ---------------------------------------------------------------------------

/**
 * Compute data confidence for a contact based on which sources it has
 * and whether those sources are fresh.
 *
 * Only considers contacts with actual interactions (interactionCount > 0)
 * for staleness warnings — LinkedIn-only contacts are "always as fresh as the export".
 *
 * Returns: { level: 'high'|'medium'|'low', reason: string, staleSourceLabels: string[] }
 */
function getContactDataConfidence(contact, syncState, now = Date.now()) {
    if (!contact) return { level: 'low', reason: 'No contact data', staleSourceLabels: [] };

    const activeSources = Object.keys(contact.sources || {}).filter(s => contact.sources[s]);
    if (activeSources.length === 0) return { level: 'low', reason: 'No data sources', staleSourceLabels: [] };

    // Only warn about staleness for contacts with actual interactions
    const hasInteractions = (contact.interactionCount || 0) > 0;
    if (!hasInteractions) {
        // LinkedIn-only contact — freshness tied to LinkedIn export age
        const linkedinSrc = syncState && syncState.linkedin;
        if (linkedinSrc && linkedinSrc.lastSyncAt) {
            const days = daysSince(linkedinSrc.lastSyncAt, now);
            if (days !== null && days > SOURCE_THRESHOLDS.linkedin) {
                return { level: 'medium', reason: 'LinkedIn export is outdated', staleSourceLabels: ['LinkedIn'] };
            }
        }
        return { level: 'high', reason: 'Contact data current', staleSourceLabels: [] };
    }

    // For contacted contacts: check if their active sources are stale
    const staleSources = activeSources.filter(source => {
        if (!SOURCE_THRESHOLDS[source]) return false;
        const src = syncState && syncState[source];
        if (!src || !src.lastSyncAt) return false;
        return isSourceStale(src.lastSyncAt, SOURCE_THRESHOLDS[source], now);
    });

    const staleLabels = staleSources.map(s => SOURCE_LABELS[s] || s);

    if (staleSources.length === 0) {
        return { level: 'high', reason: 'All sources current', staleSourceLabels: [] };
    }

    const freshSources = activeSources.filter(s => !staleSources.includes(s));
    if (freshSources.length > 0) {
        return { level: 'medium', reason: `${staleLabels.join(', ')} data may be outdated`, staleSourceLabels: staleLabels };
    }

    return { level: 'low', reason: `All sources stale (${staleLabels.join(', ')})`, staleSourceLabels: staleLabels };
}

// ---------------------------------------------------------------------------
// Overall health summary
// ---------------------------------------------------------------------------

/**
 * Compute the overall data health across all sources.
 * Returns: { level: 'ok'|'warning'|'error', warnings: [...], staleSources: [...] }
 */
function getDataHealthSummary(syncState, now = Date.now()) {
    const primaryWarnings = getPrimarySourceWarnings(syncState, now);
    const staleSources = getStaleSources(syncState, now);

    const hasError = primaryWarnings.some(w => w.severity === 'error') ||
                     (syncState && Object.values(syncState).some(s => s && s.status === 'error'));

    if (hasError) {
        return { level: 'error', warnings: primaryWarnings, staleSources };
    }
    if (primaryWarnings.length > 0 || staleSources.length > 0) {
        return { level: 'warning', warnings: primaryWarnings, staleSources };
    }
    return { level: 'ok', warnings: [], staleSources: [] };
}

module.exports = {
    daysSince,
    hoursSince,
    isSourceStale,
    getStaleSources,
    getPrimarySourceWarnings,
    getStalenessMessage,
    getContactDataConfidence,
    getDataHealthSummary,
    SOURCE_THRESHOLDS,
    SOURCE_LABELS,
    PRIMARY_SOURCES,
    FILE_SOURCES,
};
