'use strict';

/**
 * Opt-in error monitoring.
 *
 * Off by default. Activates only when MINTY_ERROR_DSN is set (Sentry-protocol
 * URL, works with self-hosted GlitchTip too). We do not capture request bodies,
 * cookies, or query strings, since this app handles personal contact data.
 *
 * Set MINTY_ERROR_RELEASE to tag events with a build identifier.
 * Set MINTY_ERROR_ENV to override the environment (default: NODE_ENV or 'development').
 */

const DSN = process.env.MINTY_ERROR_DSN || '';
const ENABLED = Boolean(DSN);

let Sentry = null;
let ready = false;

function init() {
    if (!ENABLED || ready) return;
    try {
        Sentry = require('@sentry/node');
    } catch {
        console.warn('[observability] MINTY_ERROR_DSN set but @sentry/node not installed, skipping');
        return;
    }
    Sentry.init({
        dsn: DSN,
        release: process.env.MINTY_ERROR_RELEASE || undefined,
        environment: process.env.MINTY_ERROR_ENV || process.env.NODE_ENV || 'development',
        sendDefaultPii: false,
        tracesSampleRate: 0,
        beforeSend(event) {
            if (event.request) {
                delete event.request.cookies;
                delete event.request.data;
                delete event.request.query_string;
                if (event.request.headers) {
                    for (const k of Object.keys(event.request.headers)) {
                        const lk = k.toLowerCase();
                        if (lk === 'authorization' || lk === 'cookie' || lk.startsWith('x-')) {
                            delete event.request.headers[k];
                        }
                    }
                }
                if (event.request.url) {
                    try {
                        const u = new URL(event.request.url);
                        u.search = '';
                        event.request.url = u.toString();
                    } catch {}
                }
            }
            if (event.user) {
                delete event.user.email;
                delete event.user.ip_address;
                delete event.user.username;
            }
            return event;
        },
    });
    ready = true;
    let dsnHost = 'unknown-host';
    try { dsnHost = new URL(DSN).host; } catch {}
    console.log('[observability] error monitoring active (' + dsnHost + ')');
}

function captureException(err, context) {
    if (!ENABLED || !ready || !Sentry) return;
    try {
        if (context) {
            Sentry.withScope(scope => {
                if (context.route) scope.setTag('route', context.route);
                if (context.method) scope.setTag('method', context.method);
                Sentry.captureException(err);
            });
        } else {
            Sentry.captureException(err);
        }
    } catch (e) {
        console.warn('[observability] capture failed:', e.message);
    }
}

module.exports = { init, captureException, ENABLED };
