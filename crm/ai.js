/**
 * AI backend abstraction.
 *
 * Default (AI_BACKEND=claude): uses local Claude Code CLI via `claude --print`.
 * This is used in both development and tests — Claude Code is the AI throughout.
 *
 * Optional (AI_BACKEND=ollama): falls back to a local Ollama model.
 * Only useful if you want to run without Claude Code for some reason.
 *
 * Usage:
 *   const { runAI, runAIJson } = require('./ai');
 *   const text = runAI('Summarize this in one sentence: ...');
 *   const data = runAIJson('Return a JSON array of topics from: ...');
 */

const { spawnSync } = require('child_process');

/**
 * Run a prompt through the configured AI backend.
 * Returns the raw text response.
 * Throws on non-zero exit or empty output.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.timeout=60000] - ms before giving up
 * @returns {string}
 */
function runAI(prompt, opts = {}) {
    const timeout = opts.timeout || 60000;
    const backend = process.env.AI_BACKEND || 'claude';

    if (backend === 'ollama') {
        const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
        const result = spawnSync('ollama', ['run', model], {
            input: prompt,
            encoding: 'utf8',
            timeout,
            env: {
                ...process.env,
                OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',
            },
        });
        if (result.error) throw new Error(`Ollama error: ${result.error.message}`);
        if (result.status !== 0) throw new Error(`Ollama exited ${result.status}: ${result.stderr}`);
        return (result.stdout || '').trim();
    }

    // Default: claude --print
    const result = spawnSync('claude', ['--print', '--output-format', 'text'], {
        input: prompt,
        encoding: 'utf8',
        timeout,
    });
    if (result.error) throw new Error(`Claude error: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Claude exited ${result.status}: ${result.stderr}`);
    return (result.stdout || '').trim();
}

/**
 * Run a prompt and parse the response as JSON.
 * Retries once if the first response is not valid JSON.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @returns {any}
 */
function runAIJson(prompt, opts = {}) {
    const jsonPrompt = prompt + '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation.';
    const raw = runAI(jsonPrompt, opts);
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`AI returned invalid JSON: ${e.message}\nRaw: ${raw.slice(0, 200)}`);
    }
}

module.exports = { runAI, runAIJson };
