'use strict';

// ---------------------------------------------------------------------------
// LinkedIn DOM selectors — 2026-era layout.
//
// Grouped by page. Each target exports an ARRAY of selectors; the scraper
// tries them in order and uses the first match. LinkedIn runs A/B tests on
// nearly every component, so we keep 1-2 fallbacks where reasonable.
//
// Drift sentinel: a selector returning zero matches on a page that previously
// returned rows is a signal that LinkedIn shipped a layout change. The scraper
// treats this as a potential selector-drift event (see Eng M3 / fetch.js
// row-count floor). When you edit this file, record fresh fixtures via
// `node scripts/record-fixtures.js` and re-run the parser unit tests.
//
// Selectors marked "best guess" need confirmation via recorded fixtures —
// LinkedIn has not made 2026-era class names stable enough to verify from
// docs alone. Replace with fixture-verified values on first run.
// ---------------------------------------------------------------------------

// /mynetwork/invite-connect/connections/
const CONNECTIONS_LIST = {
    url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',

    // Each connection card (list row). drift sentinel — zero matches = abort.
    card: [
        '[data-view-name="connections-list"] li',
        'li.mn-connection-card',
        'ul.mn-connections-list > li',
        'section.mn-connections li',
    ],

    // Full-name span inside a card. best guess — may need fixture update.
    fullName: [
        '[data-test-connection-name]',
        '.mn-connection-card__name',
        'span[dir="ltr"] span[aria-hidden="true"]',
        'a[href*="/in/"] span[aria-hidden="true"]',
    ],

    // Anchor whose href is the profile URL (`/in/<slug>/`).
    profileAnchor: [
        'a[data-test-app-aware-link][href*="/in/"]',
        'a.mn-connection-card__link',
        'a[href*="/in/"]',
    ],

    // "X at Y" line — Position + Company packed as one line.
    // best guess — may need fixture update.
    occupation: [
        '[data-test-connection-occupation]',
        '.mn-connection-card__occupation',
        'div.t-14.t-black--light.t-normal',
    ],

    // Element we scroll to in order to trigger the infinite-scroll load.
    scrollSentinel: [
        'footer.global-footer',
        'main[role="main"] > div:last-child',
        'body',
    ],

    // Visible "Showing N of M" counter if LinkedIn renders it. Optional.
    totalCountHint: [
        'header.mn-connections__header',
        'h1.t-18',
    ],
};

// /in/<slug>/overlay/contact-info/ (modal shown from profile)
const CONTACT_INFO_MODAL = {
    // URL template — scraper substitutes {slug}.
    urlTemplate: 'https://www.linkedin.com/in/{slug}/overlay/contact-info/',

    // Email anchor inside the modal (only shown when the other user has
    // made it visible to connections). best guess — fixture-verify.
    email: [
        'a[href^="mailto:"]',
        'section.ci-email a',
        '[data-test-contact-info-email] a',
    ],

    // "Connected on <date>" text. On some variants this lives on the main
    // profile page, not the modal — scraper tries both.
    connectedOn: [
        'section.ci-connected a',
        'section.ci-connected span',
        '[data-test-contact-info-connected-date]',
    ],

    // Current position / company headline text on the profile itself
    // (not always in the modal — scraper reads whichever is present).
    position: [
        'h1 + div .text-body-medium',
        'section.pv-top-card div.text-body-medium',
        '[data-test-profile-position]',
    ],
    company: [
        'section.pv-top-card a[href*="/company/"]',
        'li[data-test-profile-experience] a[href*="/company/"]',
    ],
};

// /messaging/
const MESSAGING_INBOX = {
    url: 'https://www.linkedin.com/messaging/',

    // Conversation list item. drift sentinel.
    conversationItem: [
        '[data-test-conversation-list-item]',
        'li.msg-conversation-listitem',
        'ul.msg-conversations-container__conversations-list > li',
    ],

    // `data-conversation-id` attribute — critical for threading.
    // If absent, scraper falls back to the anchor href's hash.
    conversationIdAttr: 'data-conversation-id',
    conversationAnchor: [
        'a[href*="/messaging/thread/"]',
        'a.msg-conversation-listitem__link',
    ],

    // Short preview text on the inbox row (ignored for CSV — only used to
    // decide if the thread has been updated since lastSync).
    threadPreview: [
        '.msg-conversation-card__message-snippet',
        'p.msg-overlay-list-bubble__message-snippet',
    ],

    // Timestamp shown next to each conversation on the inbox. Usually relative
    // ("2h", "Yesterday", "Jan 15") in visible text, with an ISO datetime in a
    // `title` or `datetime` attribute on a <time> element. We read the ISO
    // when available and use it to skip threads unchanged since lastSync. If
    // no ISO is present, we scrape the thread (safe fallback).
    threadTimestampIso: [
        'time[datetime]',
        'time[title]',
    ],
    threadTimestampText: [
        '.msg-conversation-card__time-stamp',
        'time',
    ],

    // Tabs — inbox / archived / unread / InMail. We use the tab label to
    // populate the FOLDER column.
    folderTab: [
        '[data-test-conversations-filter-tab][aria-selected="true"]',
        'nav.msg-conversations-container__filter-bar button[aria-pressed="true"]',
    ],
};

// /messaging/thread/<id>/
const MESSAGE_THREAD = {
    urlTemplate: 'https://www.linkedin.com/messaging/thread/{id}/',

    // Each message bubble in a thread. drift sentinel.
    messageBubble: [
        '[data-test-message-bubble]',
        'li.msg-s-message-list__event',
        'div.msg-s-event-listitem',
    ],

    // Sender name on the bubble.
    fromName: [
        '.msg-s-message-group__name',
        '[data-test-message-sender-name]',
    ],

    // ISO-8601 timestamp (datetime attribute on a <time> tag, usually).
    timestamp: [
        'time[datetime]',
        '[data-test-message-timestamp]',
    ],

    // Message body (HTML kept — import.js strips to text).
    bodyHtml: [
        '[data-test-message-body]',
        '.msg-s-event-listitem__body',
        'p.msg-s-event-listitem__body',
    ],

    // Attachment presence signal — just need a truthy flag, URLs not needed.
    attachmentIndicator: [
        '[data-test-attachment]',
        '.msg-s-event-listitem__attachment',
        'a[href*="dms.licdn.com"]',
    ],

    // Sender's profile URL — anchor around their avatar/name.
    senderProfileAnchor: [
        'a[data-test-message-sender-profile]',
        'a.msg-s-message-group__profile-link',
        'a[href*="/in/"]',
    ],

    // Conversation title shown at top of thread (header text).
    conversationTitle: [
        'h2.msg-entity-lockup__entity-title',
        '[data-test-thread-title]',
        'header.msg-thread-header h2',
    ],

    // Scroll anchor at the TOP of the thread — scroll to it to load older
    // messages (LinkedIn prepends on scroll-up).
    scrollTop: [
        'ul.msg-s-message-list-content',
        '.msg-s-message-list',
    ],

    // InMail-specific subject line (only populated on InMail threads).
    subject: [
        '[data-test-inmail-subject]',
        '.msg-s-inmail-subject',
    ],
};

module.exports = {
    CONNECTIONS_LIST,
    CONTACT_INFO_MODAL,
    MESSAGING_INBOX,
    MESSAGE_THREAD,
};
