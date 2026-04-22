/**
 * crm/index.js — Build the network query index
 *
 * Reads contacts.json, extracts and normalises fields needed for network queries,
 * and writes the result to data/unified/query-index.json.
 *
 * Run: node crm/index.js
 * Or:  USER_DATA_DIR=data/users/UUID/unified node crm/index.js
 *
 * This is a one-shot script run by the Ralph loop (not at runtime).
 * The web server reads query-index.json at query time via the API.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { buildIndexEntry } = require('./network-query');

// Data directory: env override for multi-tenant, default to owner's unified dir
const DATA_DIR = process.env.USER_DATA_DIR
    ? path.resolve(process.env.USER_DATA_DIR)
    : path.join(__dirname, '../data/unified');

const CONTACTS_PATH    = path.join(DATA_DIR, 'contacts.json');
const QUERY_INDEX_PATH = path.join(DATA_DIR, 'query-index.json');

function main() {
    if (!fs.existsSync(CONTACTS_PATH)) {
        console.error(`contacts.json not found at ${CONTACTS_PATH}`);
        console.error('Run "npm run merge" first to build unified contacts.');
        process.exit(1);
    }

    const raw = fs.readFileSync(CONTACTS_PATH, 'utf8');
    const contacts = JSON.parse(raw);

    console.log(`Building query index from ${contacts.length} contacts...`);

    const index = contacts
        .filter(c => !c.isGroup && c.name) // skip groups + unnamed
        .map(c => buildIndexEntry(c));

    // Spot-check: verify distribution
    const withLocation = index.filter(e => e.city).length;
    const withRole     = index.filter(e => e.roles.length > 0).length;
    const cSuite       = index.filter(e => e.seniority === 'c-suite').length;

    fs.writeFileSync(QUERY_INDEX_PATH, JSON.stringify(index, null, 2));

    console.log(`\n✓ Query index built: ${index.length} contacts`);
    console.log(`  With location:    ${withLocation} (${Math.round(withLocation / index.length * 100)}%)`);
    console.log(`  With role tags:   ${withRole} (${Math.round(withRole / index.length * 100)}%)`);
    console.log(`  C-suite/founder:  ${cSuite}`);
    console.log(`\nWritten to: ${QUERY_INDEX_PATH}`);

    // Spot-check: sample a few entries for sanity
    console.log('\nSample entries:');
    index
        .filter(e => e.city)
        .slice(0, 5)
        .forEach(e => {
            console.log(`  ${e.name} — ${e.title || '(no title)'} · ${e.city} · score ${e.relationshipScore} · meet ${e.meetScore}`);
        });
}

main();
