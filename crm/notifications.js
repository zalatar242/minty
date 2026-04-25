/**
 * crm/notifications.js — sticky per-user notifications.
 *
 * Used by auto-sync to surface "WhatsApp needs re-auth" / "LinkedIn session
 * expired" banners that the UI shows until the user dismisses them.
 *
 * Storage: data/<userDataDir>/notifications.json — { source: { ...payload, since } }.
 * Pause-after-failure: when a payload includes pauseSync=true, the auto-sync
 * scheduler skips that source until the notification is dismissed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function notifPath(userDataDir) {
    return path.join(userDataDir, 'notifications.json');
}

function readAll(userDataDir) {
    try {
        const raw = fs.readFileSync(notifPath(userDataDir), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeAll(userDataDir, all) {
    const p = notifPath(userDataDir);
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
        fs.renameSync(tmp, p);
        try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
        return true;
    } catch {
        return false;
    }
}

function set(userDataDir, key, payload) {
    const all = readAll(userDataDir);
    all[key] = {
        source: key,
        ...payload,
        since: payload?.since || all[key]?.since || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return writeAll(userDataDir, all);
}

function dismiss(userDataDir, key) {
    const all = readAll(userDataDir);
    if (!(key in all)) return false;
    delete all[key];
    return writeAll(userDataDir, all);
}

function list(userDataDir) {
    return readAll(userDataDir);
}

function isPaused(userDataDir, source) {
    const all = readAll(userDataDir);
    return !!(all[source] && all[source].pauseSync);
}

module.exports = { set, dismiss, list, isPaused, readAll };
