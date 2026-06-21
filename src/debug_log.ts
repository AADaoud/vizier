/**
 * debug_log.ts
 *
 * Opt-in verbose conversation-flow logger. When "Debug logging" is enabled in
 * settings, every agent turn appends a detailed, human-readable record to
 * `vizier_debug.log` in the plugin folder: the request, the system prompt, each
 * round's model decision (reasoning + tool calls), every tool call with its
 * params/result, the verifier verdict, the final response, and any errors.
 *
 * This is the analysis instrument for diagnosing agent behaviour. It is OFF by
 * default and writes nothing until enabled. Distinct from traces.ts, which
 * records one compact JSONL metric row per run regardless of this toggle.
 *
 * Usage:
 *   initDebugLog(pluginDir);          // once in onload()
 *   setDebugLogging(settings.features.debugLog);
 *   const dbg = startDebugTurn('agent', userMessage);
 *   dbg.log('System prompt', systemText);
 *   dbg.end('done', { ok: true });
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Module state ─────────────────────────────────────────────────────────────

let _file: string | null = null;
let _enabled = false;
let _seq = 0;

const MAX_BYTES = 10 * 1024 * 1024; // rotate at 10 MB
const FIELD_CAP = 16_000;           // truncate any single field past this
const RULE = '═'.repeat(78);
const SUB  = '─'.repeat(78);

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function initDebugLog(pluginDir: string): void {
	_file = pluginDir ? path.join(pluginDir, 'vizier_debug.log') : null;
}

export function setDebugLogging(enabled: boolean): void {
	_enabled = enabled;
}

export function isDebugLogging(): boolean {
	return _enabled && _file !== null;
}

/** Absolute path of the debug log (for surfacing in the UI), or null. */
export function debugLogPath(): string | null {
	return _file;
}

// ── Turn-scoped logger ───────────────────────────────────────────────────────

export interface DebugTurn {
	/** True when this turn is actually recording (debug logging is on). */
	readonly active: boolean;
	/** Append a labelled section with optional string/object payload. */
	log(label: string, data?: unknown): void;
	/** Close the turn with an optional summary payload. */
	end(label?: string, data?: unknown): void;
}

const NOOP_TURN: DebugTurn = { active: false, log() {}, end() {} };

/**
 * Begin a turn-scoped logger. Returns a no-op logger when debug logging is off,
 * so callers can sprinkle `dbg.log(...)` without guarding each call.
 */
export function startDebugTurn(kind: string, summary: string): DebugTurn {
	if (!isDebugLogging()) return NOOP_TURN;

	const id = `${Date.now().toString(36)}-${(_seq++).toString(36)}`;
	write(
		`\n${RULE}\n` +
		`▶ ${kind.toUpperCase()} TURN ${id}  ${stamp()}\n` +
		`  ${cap(summary).replace(/\s+/g, ' ').trim()}\n` +
		`${RULE}\n`
	);

	return {
		active: true,
		log(label, data) {
			const body = fmt(data);
			write(`\n┌─ ${label}  (${stamp()})\n` + (body ? indent(body) + '\n' : ''));
		},
		end(label = 'END', data) {
			const body = fmt(data);
			write(`\n└─ ${label}  (${stamp()})\n` + (body ? indent(body) + '\n' : '') + `${SUB}\n`);
		},
	};
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stamp(): string {
	return new Date().toISOString();
}

function cap(s: string): string {
	return s.length > FIELD_CAP
		? s.slice(0, FIELD_CAP) + `\n…[truncated ${s.length - FIELD_CAP} chars]`
		: s;
}

function fmt(data: unknown): string {
	if (data === undefined || data === null) return '';
	if (typeof data === 'string') return cap(data);
	try { return cap(JSON.stringify(data, null, 2)); } catch { return '[unserializable value]'; }
}

function indent(s: string): string {
	return s.split('\n').map(l => '   ' + l).join('\n');
}

function write(text: string): void {
	if (!isDebugLogging()) return;
	try {
		rotateIfNeeded(_file as string);
		fs.appendFileSync(_file as string, text, 'utf-8');
	} catch { /* never let logging crash the plugin */ }
}

function rotateIfNeeded(file: string): void {
	try {
		const stat = fs.statSync(file);
		if (stat.size > MAX_BYTES) fs.renameSync(file, file + '.1');
	} catch { /* file doesn't exist yet — that's fine */ }
}
