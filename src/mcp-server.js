#!/usr/bin/env node
/**
 * Claude Privacy Tool - MCP server for Claude Desktop.
 * Exposes privacy_sanitize, privacy_desanitize, privacy_list_sessions, privacy_purge_session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from '@modelcontextprotocol/sdk/node_modules/zod/v3/index.js';
import {
    sanitize,
    desanitize,
    saveMapping,
    loadMapping,
    loadSessionMappings,
    listSessions,
    purgeSession,
    log,
} from './sanitizer.js';

const server = new McpServer({
    name: 'claude-privacy-tool',
    version: '1.0.0',
});

server.tool(
    'privacy_sanitize',
    'Pseudonymize all personal data in the given text. Replaces every detected PII (names, addresses, emails, phones, dates, account numbers, secrets) with numbered placeholders like [PRIVATE_PERSON_1], [ACCOUNT_NUMBER_1]. Originals are stored locally and recoverable via privacy_desanitize using the returned mapping_id.',
    {
        text: z.string().describe('Raw text to sanitize'),
        session_id: z.string().optional().describe('Logical session to group multiple mappings. Default "default".'),
    },
    async ({ text, session_id }) => {
        const sid = session_id || 'default';
        if (!text || !text.trim()) {
            return { content: [{ type: 'text', text: JSON.stringify({ masked: text || '', mapping_id: null, stats: {}, entity_count: 0 }) }] };
        }
        const { masked, mapping, stats } = await sanitize(text);
        if (Object.keys(mapping).length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ masked: text, mapping_id: null, stats: {}, entity_count: 0 }) }] };
        }
        const mappingId = saveMapping(sid, mapping);
        log(`sanitize session=${sid} entities=${Object.keys(mapping).length} mapping_id=${mappingId}`);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    masked,
                    mapping_id: mappingId,
                    stats,
                    entity_count: Object.keys(mapping).length,
                }),
            }],
        };
    }
);

server.tool(
    'privacy_desanitize',
    'Replace placeholders with their original values using a stored mapping. If mapping_id is provided, only that mapping is used. Otherwise all mappings for session_id are merged and applied.',
    {
        text: z.string().describe('Text containing placeholders produced by privacy_sanitize'),
        mapping_id: z.string().optional().describe('Specific mapping to use (optional)'),
        session_id: z.string().optional().describe('Session whose mappings should be merged if mapping_id is empty'),
    },
    async ({ text, mapping_id, session_id }) => {
        const mapping = mapping_id ? (loadMapping(mapping_id) || {}) : loadSessionMappings(session_id || 'default');
        if (Object.keys(mapping).length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ original: text, replacements: 0 }) }] };
        }
        const { restored, replacements } = desanitize(text, mapping);
        log(`desanitize session=${session_id || 'default'} replacements=${replacements}`);
        return { content: [{ type: 'text', text: JSON.stringify({ original: restored, replacements }) }] };
    }
);

server.tool(
    'privacy_list_sessions',
    'List all session IDs that currently have stored mappings on disk.',
    {},
    async () => {
        const sessions = listSessions();
        return { content: [{ type: 'text', text: JSON.stringify({ sessions, count: sessions.length }) }] };
    }
);

server.tool(
    'privacy_purge_session',
    'Delete all mappings for a given session. Irreversible. Use this to comply with GDPR right-to-erasure requests.',
    {
        session_id: z.string().describe('Session ID to purge'),
    },
    async ({ session_id }) => {
        const deleted = purgeSession(session_id);
        log(`purged session=${session_id} files=${deleted}`);
        return { content: [{ type: 'text', text: JSON.stringify({ deleted }) }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
