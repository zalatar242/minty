# LinkedIn HTML fixtures

This directory holds HTML snapshots of LinkedIn pages used for offline parser
tests in `tests/unit/linkedin-scrape.test.js`. These fixtures let the test
suite run in CI without a live LinkedIn session.

## What's here

- `connections-list.html` — snapshot of
  `https://www.linkedin.com/mynetwork/invite-connect/connections/` after
  infinite-scroll has loaded all connections.
- `contact-info-modal.html` — snapshot of the `/overlay/contact-info/` modal
  for a single connection.
- `messaging-inbox.html` — snapshot of `https://www.linkedin.com/messaging/`
  showing the conversation list.
- `message-thread.html` — snapshot of a single thread
  (`/messaging/thread/<id>/`).

On first checkout these files may not exist; the parser unit tests fall back
to tiny synthetic HTML fixtures defined inline in the test file. Running
`node scripts/record-fixtures.js` will populate the directory from the user's
own LinkedIn session.

## Recording fresh fixtures

Prerequisites: you've already run `npm run linkedin:setup` and
`npm run linkedin:connect` at least once, so `data/linkedin/browser-profile/`
exists with a valid session.

```sh
node scripts/record-fixtures.js
```

This opens a headless Chromium using the saved profile, visits each of the
four pages above, and writes `page.content()` to the files in this directory.
It runs in about 30 seconds and respects `LINKEDIN_THROTTLE_MS` between
navigations.

## Refreshing after a selector change

When a contributor notices the scraper has broken (empty rows, row-count
floor trips), the fix is typically:

1. Update `sources/linkedin/selectors.js` with the new class names.
2. Re-record fixtures: `node scripts/record-fixtures.js`.
3. Re-run unit tests: `node --test tests/unit/linkedin-scrape.test.js`.
4. Commit selectors + fixtures in the same PR.

## Privacy

These fixtures contain REAL connection names, message bodies, and profile
URLs from the recording user's account. Do not commit them to a public repo
without scrubbing. The provided `.gitignore` should list
`sources/linkedin/fixtures/*.html` to prevent accidental commit; the
`README.md` and any synthetic fixture files are the only tracked content.
