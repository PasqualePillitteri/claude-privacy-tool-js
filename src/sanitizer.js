/**
 * Claude Privacy Tool - core sanitizer.
 * Wraps OpenAI Privacy Filter via @huggingface/transformers (pure JS).
 * No Python, no venv, no compilation.
 */
import { pipeline, env } from '@huggingface/transformers';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ROOT = join(homedir(), '.claude', 'privacy-tool');
export const MAPPINGS_DIR = join(ROOT, 'mappings');
export const LOG_FILE = join(ROOT, 'cpt.log');
export const MODEL_ID = 'openai/privacy-filter';

// Redirect HF cache inside the tool dir so everything lives under ~/.claude/privacy-tool
env.cacheDir = join(ROOT, 'cache');

let _classifier = null;

function ensureDirs() {
    mkdirSync(MAPPINGS_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(ROOT, { recursive: true });
}

export function log(msg) {
    ensureDirs();
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`, 'utf-8');
}

export async function getClassifier() {
    if (_classifier) return _classifier;
    _classifier = await pipeline('token-classification', MODEL_ID, {
        aggregation_strategy: 'simple',
        dtype: 'fp32',
    });
    log('Model loaded');
    return _classifier;
}

/**
 * Merge adjacent entities of the same group.
 * Fixes aggregation_strategy="simple" edge case where the last token of a span
 * is tagged slightly differently and breaks the entity in two adjacent pieces
 * (e.g. "pasquale pillitter" + "i", "05/02/199" + "0").
 */
function mergeConsecutive(entities, maxGap = 1) {
    if (!entities.length) return [];
    const sorted = [...entities].sort((a, b) => a.start - b.start);
    const merged = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i += 1) {
        const ent = sorted[i];
        const last = merged[merged.length - 1];
        const sameGroup = (ent.entity_group || ent.entity) === (last.entity_group || last.entity);
        if (sameGroup && ent.start - last.end <= maxGap) {
            last.end = ent.end;
            last.score = Math.max(last.score || 0, ent.score || 0);
        } else {
            merged.push({ ...ent });
        }
    }
    return merged;
}

/**
 * Pseudonymize text by replacing PII spans with numbered placeholders.
 * @param {string} text
 * @returns {Promise<{masked: string, mapping: Record<string,string>, stats: Record<string,number>}>}
 */
export async function sanitize(text) {
    const classifier = await getClassifier();
    const raw = await classifier(text);
    const entities = mergeConsecutive(raw, 1).sort((a, b) => b.start - a.start);

    const mapping = {};
    const counters = {};
    const seen = new Map();

    let masked = text;
    for (const ent of entities) {
        const group = String(ent.entity_group || ent.entity || '').toUpperCase();
        if (!group) continue;
        const original = text.slice(ent.start, ent.end);
        const key = `${group}::${original.trim().toLowerCase()}`;

        let placeholder = seen.get(key);
        if (!placeholder) {
            counters[group] = (counters[group] || 0) + 1;
            placeholder = `[${group}_${counters[group]}]`;
            seen.set(key, placeholder);
            mapping[placeholder] = original;
        }
        masked = masked.slice(0, ent.start) + placeholder + masked.slice(ent.end);
    }

    return { masked, mapping, stats: counters };
}

/**
 * Store a mapping JSON under ~/.claude/privacy-tool/mappings/{mapping_id}.json
 * @returns {string} mapping_id
 */
export function saveMapping(sessionId, mapping) {
    ensureDirs();
    const mappingId = `${sessionId}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const path = join(MAPPINGS_DIR, `${mappingId}.json`);
    writeFileSync(path, JSON.stringify(mapping, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
    return mappingId;
}

export function loadMapping(mappingId) {
    const path = join(MAPPINGS_DIR, `${mappingId}.json`);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return null;
    }
}

export function loadSessionMappings(sessionId) {
    if (!existsSync(MAPPINGS_DIR)) return {};
    const merged = {};
    for (const name of readdirSync(MAPPINGS_DIR)) {
        if (!name.startsWith(`${sessionId}_`) || !name.endsWith('.json')) continue;
        try {
            Object.assign(merged, JSON.parse(readFileSync(join(MAPPINGS_DIR, name), 'utf-8')));
        } catch { /* ignore */ }
    }
    return merged;
}

export function desanitize(text, mapping) {
    const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
    let restored = text;
    let replacements = 0;
    for (const placeholder of keys) {
        if (restored.includes(placeholder)) {
            restored = restored.split(placeholder).join(mapping[placeholder]);
            replacements += 1;
        }
    }
    return { restored, replacements };
}

export function listSessions() {
    if (!existsSync(MAPPINGS_DIR)) return [];
    const set = new Set();
    for (const name of readdirSync(MAPPINGS_DIR)) {
        if (!name.endsWith('.json')) continue;
        const parts = name.replace(/\.json$/, '').split('_');
        parts.pop();
        set.add(parts.join('_'));
    }
    return [...set].sort();
}

export function purgeSession(sessionId) {
    if (!existsSync(MAPPINGS_DIR)) return 0;
    let deleted = 0;
    for (const name of readdirSync(MAPPINGS_DIR)) {
        if (!name.startsWith(`${sessionId}_`) || !name.endsWith('.json')) continue;
        try { unlinkSync(join(MAPPINGS_DIR, name)); deleted += 1; } catch { /* ignore */ }
    }
    return deleted;
}
