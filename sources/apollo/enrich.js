/**
 * Apollo.io contact enrichment.
 *
 * Calls the Apollo People Match API for each contact that has a LinkedIn URL,
 * adds location, headline, social profiles, employment history, education, etc.
 * Results are stored in data/apollo/enrichment.json (keyed by stable contact ID)
 * and merged into unified contacts via merge.js.
 *
 * Usage:
 *   APOLLO_API_KEY=your_key node sources/apollo/enrich.js
 *   APOLLO_API_KEY=your_key node sources/apollo/enrich.js --limit 50   # enrich 50 at a time
 *   APOLLO_API_KEY=your_key node sources/apollo/enrich.js --dry-run     # preview without calling API
 *
 * Resumable: already-enriched contacts are skipped automatically.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../../data');
const OUT_PATH = path.join(DATA, 'apollo/enrichment.json');
const APOLLO_URL = 'https://api.apollo.io/api/v1/people/match';

const API_KEY = process.env.APOLLO_API_KEY;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
    const i = args.indexOf('--limit');
    return i !== -1 ? parseInt(args[i + 1], 10) : Infinity;
})();
// Delay between requests in ms — adjust based on your Apollo plan's rate limit
const DELAY_MS = 500;

if (!API_KEY && !DRY_RUN) {
    console.error('Error: APOLLO_API_KEY environment variable is required.');
    console.error('Usage: APOLLO_API_KEY=your_key node sources/apollo/enrich.js');
    process.exit(1);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function apolloMatch(contact) {
    const li = contact.sources.linkedin;
    const body = {
        linkedin_url: li.profileUrl,
        reveal_personal_emails: false,
        reveal_phone_number: false,
    };

    const res = await fetch(APOLLO_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'x-api-key': API_KEY,
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Apollo API ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.person || null;
}

// Extract the fields we care about from Apollo's person object
function extractEnrichment(person) {
    if (!person) return null;
    return {
        enrichedAt: new Date().toISOString(),
        location: [person.city, person.state, person.country].filter(Boolean).join(', ') || null,
        country: person.country || null,
        city: person.city || null,
        headline: person.headline || null,
        photoUrl: person.photo_url || null,
        twitterUrl: person.twitter_url || null,
        githubUrl: person.github_url || null,
        employmentHistory: (person.employment_history || []).map(e => ({
            title: e.title,
            company: e.organization_name,
            current: e.current,
            startDate: e.start_date,
            endDate: e.end_date,
        })),
        education: (person.education_history || []).map(e => ({
            school: e.school_name,
            degree: e.degree,
            field: e.field_of_study,
            startYear: e.start_date,
            endYear: e.end_date,
        })),
    };
}

async function run() {
    const contacts = JSON.parse(fs.readFileSync(path.join(DATA, 'unified/contacts.json'), 'utf8'));

    // Load existing enrichment (resumable)
    fs.mkdirSync(path.join(DATA, 'apollo'), { recursive: true });
    const enrichment = fs.existsSync(OUT_PATH)
        ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'))
        : {};

    const candidates = contacts.filter(c =>
        c.sources.linkedin?.profileUrl &&
        !enrichment[c.id]   // skip already enriched
    );

    const toEnrich = candidates.slice(0, LIMIT);

    console.log(`Total contacts: ${contacts.length}`);
    console.log(`Already enriched: ${Object.keys(enrichment).length}`);
    console.log(`Candidates remaining: ${candidates.length}`);
    console.log(`Enriching this run: ${toEnrich.length}${DRY_RUN ? ' (dry run)' : ''}`);
    if (DELAY_MS) console.log(`Delay between requests: ${DELAY_MS}ms`);
    console.log('');

    let success = 0, notFound = 0, errors = 0;

    for (let i = 0; i < toEnrich.length; i++) {
        const contact = toEnrich[i];
        const profileUrl = contact.sources.linkedin.profileUrl;
        process.stdout.write(`[${i + 1}/${toEnrich.length}] ${contact.name} … `);

        if (DRY_RUN) {
            console.log(`(dry run) ${profileUrl}`);
            continue;
        }

        try {
            const person = await apolloMatch(contact);
            const result = extractEnrichment(person);

            if (!result) {
                console.log('not found');
                enrichment[contact.id] = { enrichedAt: new Date().toISOString(), notFound: true };
                notFound++;
            } else {
                console.log(result.location || 'no location');
                enrichment[contact.id] = result;
                success++;
            }

            // Save after every request so progress isn't lost on interrupt
            fs.writeFileSync(OUT_PATH, JSON.stringify(enrichment, null, 2));
        } catch (e) {
            console.log(`ERROR: ${e.message}`);
            errors++;
        }

        if (i < toEnrich.length - 1) await sleep(DELAY_MS);
    }

    console.log(`\nDone. Success: ${success}, Not found: ${notFound}, Errors: ${errors}`);
    console.log(`Enrichment saved to data/apollo/enrichment.json`);
    console.log(`Run 'node crm/merge.js' to incorporate into unified contacts.`);
}

run().catch(e => { console.error(e); process.exit(1); });
