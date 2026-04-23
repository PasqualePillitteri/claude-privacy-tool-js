#!/usr/bin/env node
/**
 * Claude Privacy Tool - UserPromptSubmit hook for Claude Code.
 * Reads JSON from stdin, sanitizes prompt, writes modified event to stdout.
 */
import { sanitize, saveMapping, log } from './sanitizer.js';

function readStdin() {
    return new Promise((resolve) => {
        let buf = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { buf += chunk; });
        process.stdin.on('end', () => resolve(buf));
        if (process.stdin.isTTY) resolve('');
    });
}

async function main() {
    const raw = await readStdin();
    let event = {};
    try { event = raw.trim() ? JSON.parse(raw) : {}; }
    catch (e) { log(`ERROR decoding stdin: ${e.message}`); return; }

    const prompt = event.prompt || event.user_prompt || '';
    const sessionId = event.session_id || 'default';
    if (!prompt.trim()) return;

    try {
        const { masked, mapping, stats } = await sanitize(prompt);
        if (Object.keys(mapping).length === 0) {
            log(`session=${sessionId} no PII detected, passthrough`);
            return;
        }
        const mappingId = saveMapping(sessionId, mapping);
        const statsStr = Object.entries(stats)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}(${v})`)
            .join(', ');
        log(`session=${sessionId} sanitized ${Object.keys(mapping).length} entities: ${statsStr} mapping_id=${mappingId}`);

        const output = {
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                updatedInput: masked,
                additionalContext: `[Claude Privacy Tool] User prompt contained PII, automatically pseudonymized. Categories redacted: ${statsStr}. Mapping ID (local only): ${mappingId}. Answer using the placeholders as they appear; they will be automatically replaced with the real values before display to the user.`,
            },
        };
        process.stdout.write(JSON.stringify(output));
    } catch (e) {
        log(`ERROR sanitize: ${e.message}`);
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: `[PrivacyTool WARNING] Sanitization failed: ${e.message}. Sending original prompt.`,
            },
        }));
    }
}

main().catch((e) => { log(`FATAL: ${e.stack || e.message}`); });
