#!/usr/bin/env node
/**
 * Claude Privacy Tool - CLI entry.
 * Commands: install, uninstall, test, version.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const ROOT = join(homedir(), '.claude', 'privacy-tool');
const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');

function desktopConfigPath() {
    if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (platform() === 'linux') return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'Claude', 'claude_desktop_config.json');
}

function readJson(path) {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf-8') || '{}'); } catch { return {}; }
}

function writeJson(path, obj) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

const BIN_HOOK = `node ${join(PACKAGE_ROOT, 'src', 'hook.js').replace(/ /g, '\\ ')}`;
const BIN_POST = `node ${join(PACKAGE_ROOT, 'src', 'postresponse.js').replace(/ /g, '\\ ')}`;
const MCP_CMD = 'node';
const MCP_ARGS = [join(PACKAGE_ROOT, 'src', 'mcp-server.js')];

function ensureHook(settings, eventName, cmd) {
    settings.hooks ??= {};
    settings.hooks[eventName] ??= [];
    for (const g of settings.hooks[eventName]) {
        if ((g.hooks || []).some((h) => h.command === cmd)) return false;
    }
    settings.hooks[eventName].push({ matcher: '*', hooks: [{ type: 'command', command: cmd }] });
    return true;
}

async function cmdInstall() {
    console.log('[Claude Privacy Tool] Installing...');

    // Claude Code hooks
    const settings = readJson(SETTINGS_FILE);
    const hookAdded = ensureHook(settings, 'UserPromptSubmit', BIN_HOOK);
    const stopAdded = ensureHook(settings, 'Stop', BIN_POST);
    writeJson(SETTINGS_FILE, settings);
    console.log(`[OK] Claude Code hooks: ${hookAdded || stopAdded ? 'registered' : 'already present'}`);

    // Claude Desktop MCP
    const dcPath = desktopConfigPath();
    const dc = readJson(dcPath);
    dc.mcpServers ??= {};
    dc.mcpServers['claude-privacy-tool'] = { command: MCP_CMD, args: MCP_ARGS };
    writeJson(dcPath, dc);
    console.log(`[OK] Claude Desktop MCP server registered at ${dcPath}`);
    console.log('[!!] Restart Claude Desktop to load the MCP server');

    // Ensure runtime dirs
    mkdirSync(join(ROOT, 'mappings'), { recursive: true, mode: 0o700 });

    console.log('\n[Claude Privacy Tool] Installed.\n');
    console.log("Claude Code CLI   hooks active, run 'claude' as usual");
    console.log('Claude Desktop    restart the app to load the MCP server');
    console.log('\nModel download (~3 GB) happens on first prompt, one time only.');
    console.log(`Logs:     ${join(ROOT, 'cpt.log')}`);
    console.log(`Mappings: ${join(ROOT, 'mappings')} (0700)`);
    console.log('Uninstall: claude-privacy-tool uninstall');
}

async function cmdUninstall() {
    console.log('[Claude Privacy Tool] Uninstalling...');
    const settings = readJson(SETTINGS_FILE);
    for (const event of Object.keys(settings.hooks || {})) {
        settings.hooks[event] = (settings.hooks[event] || []).filter(
            (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('claude-privacy-tool') || String(h.command || '').includes('privacy-tool/src/hook') || String(h.command || '').includes('privacy-tool/src/postresponse'))
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    writeJson(SETTINGS_FILE, settings);
    console.log('[OK] Claude Code hooks removed');

    const dcPath = desktopConfigPath();
    const dc = readJson(dcPath);
    if (dc.mcpServers && dc.mcpServers['claude-privacy-tool']) {
        delete dc.mcpServers['claude-privacy-tool'];
        if (Object.keys(dc.mcpServers).length === 0) delete dc.mcpServers;
        writeJson(dcPath, dc);
        console.log('[OK] Claude Desktop MCP server removed');
    }
    console.log('\n[Claude Privacy Tool] Uninstalled. Data in ~/.claude/privacy-tool/ kept.');
    console.log('Delete manually if you also want to wipe mappings and model cache.');
}

async function cmdTest() {
    console.log('[Claude Privacy Tool] Running smoke test...');
    const sample = {
        prompt: 'Il cliente Mario Rossi (mario@test.com, IBAN IT60X054281110100000012345) ha firmato il 12/03/2026',
        session_id: 'test',
    };
    const child = spawn('node', [join(PACKAGE_ROOT, 'src', 'hook.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.write(JSON.stringify(sample));
    child.stdin.end();
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    await new Promise((r) => child.on('close', r));
    try {
        const parsed = JSON.parse(out);
        console.log('\n[OK] Test passed. Sanitized output:\n');
        console.log(JSON.stringify(parsed, null, 2));
    } catch {
        console.log('\n[!!] Test returned raw output:');
        console.log(out);
    }
}

function cmdVersion() {
    const pkg = readJson(join(PACKAGE_ROOT, 'package.json'));
    console.log(`Claude Privacy Tool v${pkg.version}`);
}

function help() {
    console.log(`Claude Privacy Tool - mask personal data before it reaches Claude

Usage:
  claude-privacy-tool install      Register hooks in Claude Code + MCP server in Claude Desktop
  claude-privacy-tool uninstall    Remove hooks and MCP server registration
  claude-privacy-tool test         Run a smoke test with a sample prompt
  claude-privacy-tool version      Show version

Docs: https://github.com/pasqualepillitteri/claude-privacy-tool-js`);
}

const cmd = process.argv[2];
switch (cmd) {
    case 'install': await cmdInstall(); break;
    case 'uninstall': await cmdUninstall(); break;
    case 'test': await cmdTest(); break;
    case 'version':
    case '--version':
    case '-v': cmdVersion(); break;
    default: help(); break;
}
