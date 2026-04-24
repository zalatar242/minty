#!/usr/bin/env node
/**
 * scripts/export-data.js — CLI to produce a portable Minty bundle.
 *
 * Usage:
 *   node scripts/export-data.js [output-path]
 *   node scripts/export-data.js [output-path] --encrypt
 *     (prompts for passphrase twice via stdin)
 *
 * Default output: ./minty-<timestamp>.minty.bundle(.gz)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { exportAll } = require('../crm/export');

const DATA = process.env.CRM_DATA_DIR || path.join(__dirname, '../data');

function promptHidden(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const stdin = process.stdin;
        let input = '';
        process.stdout.write(prompt);

        const onData = (char) => {
            const c = char.toString();
            if (c === '\n' || c === '\r' || c === '\r\n') {
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                rl.close();
                resolve(input);
            } else if (c === '') { // Ctrl-C
                process.exit(1);
            } else if (c === '') { // backspace
                input = input.slice(0, -1);
            } else {
                input += c;
            }
        };

        stdin.setRawMode && stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
    });
}

async function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const encrypt = process.argv.includes('--encrypt');

    let passphrase = null;
    if (encrypt) {
        passphrase = await promptHidden('Passphrase: ');
        if (!passphrase) { console.error('Empty passphrase — aborting.'); process.exit(2); }
        const verify = await promptHidden('Confirm:    ');
        if (verify !== passphrase) { console.error('Passphrases do not match — aborting.'); process.exit(2); }
    }

    const { buffer, filename, stats, encrypted } = exportAll(DATA, { passphrase });
    const outPath = args[0] || path.join(process.cwd(), filename);
    fs.writeFileSync(outPath, buffer);
    console.log(
        (encrypted ? '🔐 Encrypted' : '📦 Plain') +
        ` bundle written: ${outPath}\n  ${stats.contacts} contacts · ${stats.interactions} interactions · ` +
        `${stats.insights || 0} insights · ${stats.goals || 0} goals\n  ${fmtSize(buffer.length)}`
    );
}

function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
}

main().catch(e => { console.error(e); process.exit(1); });
