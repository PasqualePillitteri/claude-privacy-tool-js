#!/usr/bin/env node
/**
 * Claude Privacy Tool - Stop hook for Claude Code.
 * Restores placeholders in the assistant response using local mappings.
 */
import { desanitize, loadSessionMappings } from './sanitizer.js';

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
    catch { return; }

    const sessionId = event.session_id || 'default';
    const response = event.response || event.assistant_response || '';
    if (!response.trim()) return;

    const mapping = loadSessionMappings(sessionId);
    if (Object.keys(mapping).length === 0) return;

    const { restored } = desanitize(response, mapping);
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'Stop',
            updatedResponse: restored,
        },
    }));
}

main().catch(() => { /* silent failure, do not block Claude Code */ });
