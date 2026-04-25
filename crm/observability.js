'use strict';

/**
 * Opt-in error monitoring + crash safety.
 *
 * Off by default. Sentry/GlitchTip-protocol error monitoring activates only
 * when MINTY_ERROR_DSN is set. Even with monitoring off, init() still wires
 * uncaughtException/unhandledRejection handlers so crashes leave a
 * recognisable trace in stderr instead of being swallowed.
 *
 * We do not capture request bodies, cookies, or query strings — this app
 * handles personal contact data.
 *
 *   MINTY_ERROR_DSN     — turn on remote error reporting
 *   MINTY_ERROR_RELEASE — tag events with a build identifier
 *   MINTY_ERROR_ENV     — override the environment label
 */

const DSN = process.env.MINTY_ERROR_DSN || '';
const ENABLED = Boolean(DSN);

let Sentry = null;
let ready = false;
let crashHandlersInstalled = false;

function installCrashHandlers() {
    if (crashHandlersInstalled) return;
    crashHandlersInstalled = true;
    process.on('uncaughtException', (err) => {
        console.error('[observability] uncaughtException:', err && (err.stack || err.message || err));
        if (ready && Sentry) try { Sentry.captureException(err); } catch {}
    });
    process.on('unhandledRejection', (reason) => {
        console.error('[observability] unhandledRejection:', reason && (reason.stack || reason.message || reason));
        if (ready && Sentry) try { Sentry.captureException(reason); } catch {}
    });
}

function init() {
    installCrashHandlers();
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
