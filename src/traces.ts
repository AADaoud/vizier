/**
 * traces.ts
 *
 * Lightweight JSONL run logger — port of Odysseus's run_traces.py.
 *
 * Every command/agent run appends one line to vizier_runs.jsonl in the plugin
 * folder. Rotates at ~5 MB so the file can't grow unbounded. The trace log is
 * the primary tuning instrument: read it monthly, turn failures into rules,
 * turn successes into skills.
 *
 * Usage:
 *   import { initTraces, recordRun, readRuns, summarizeRuns } from './traces';
 *   initTraces('/path/to/plugin/dir');  // call once in plugin onload()
 *   recordRun({ kind: 'agent', model: 'gemma3:12b', ok: true, duration_ms: 1200 });
 */

// Use Node.js fs — available in Obsidian's Electron environment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');

// ── Types ──────────────────────────────────────────────────────────────────

export interface RunTrace {
	/** 'agent' | 'command' | 'memory' | 'intake' | 'briefing' | 'skill' | 'verify' */
	kind: string;
	model?: string;
	role?: string;
	duration_ms?: number;
	tokens_in?: number;
	tokens_out?: number;
	tools_used?: string[];
	notes_touched?: number;
	ok?: boolean;
	error?: string;
	schema_version?: string;
	fallback?: boolean;
	[key: string]: unknown;
}

interface StoredTrace extends RunTrace {
	ts: number;
	id: string;
}

// ── Module state ───────────────────────────────────────────────────────────

let _traceFile: string | null = null;
const MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB

export function initTraces(pluginDir: string): void {
	_traceFile = path.join(pluginDir, 'vizier_runs.jsonl');
}

// ── Core operations ────────────────────────────────────────────────────────

export function recordRun(trace: RunTrace): StoredTrace {
	const row: StoredTrace = {
		ts: Date.now(),
		id: `${Date.now()}-${Math.floor(Math.random() * 65536).toString(16)}`,
		...trace,
	};

	if (!_traceFile) return row; // traces not initialized yet

	try {
		rotateIfNeeded(_traceFile);
		fs.appendFileSync(_traceFile, JSON.stringify(row) + '\n', 'utf-8');
	} catch { /* never let a trace failure crash the plugin */ }

	return row;
}

export function readRuns(limit = 100, kind?: string): StoredTrace[] {
	if (!_traceFile) return [];
	try {
		const raw = fs.readFileSync(_traceFile, 'utf-8');
		const rows: StoredTrace[] = [];
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try { rows.push(JSON.parse(trimmed) as StoredTrace); } catch { /* skip bad lines */ }
		}
		const filtered = kind ? rows.filter(r => r.kind === kind) : rows;
		return filtered.reverse().slice(0, limit);
	} catch { return []; }
}

export interface RunStats {
	total: number;
	passed: number;
	failed: number;
	by_kind: Record<string, number>;
	by_model: Record<string, number>;
	avg_duration_ms: number;
	fallback_rate: number;
}

export function summarizeRuns(limit = 500): RunStats {
	const rows = readRuns(limit);
	const by_kind: Record<string, number> = {};
	const by_model: Record<string, number> = {};
	let passed = 0, failed = 0, total_ms = 0, fallbacks = 0, ms_count = 0;

	for (const r of rows) {
		const k = r.kind ?? '?';
		by_kind[k] = (by_kind[k] ?? 0) + 1;
		if (r.model) { by_model[r.model] = (by_model[r.model] ?? 0) + 1; }
		if (r.ok === true) passed++;
		else if (r.ok === false) failed++;
		if (typeof r.duration_ms === 'number') { total_ms += r.duration_ms; ms_count++; }
		if (r.fallback) fallbacks++;
	}

	return {
		total: rows.length,
		passed,
		failed,
		by_kind,
		by_model,
		avg_duration_ms: ms_count ? Math.round(total_ms / ms_count) : 0,
		fallback_rate:   rows.length ? Math.round((fallbacks / rows.length) * 100) : 0,
	};
}

/** Format run stats as a markdown string for the chat view. */
export function formatRunStats(limit = 200): string {
	const s = summarizeRuns(limit);
	if (s.total === 0) return 'No runs recorded yet. Traces will appear here after using Vizier.';

	const passRate = s.passed + s.failed > 0
		? Math.round((s.passed / (s.passed + s.failed)) * 100)
		: null;

	const kindLines = Object.entries(s.by_kind)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `  - ${k}: ${n}`)
		.join('\n');

	const modelLines = Object.entries(s.by_model)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([m, n]) => `  - ${m}: ${n}`)
		.join('\n');

	return [
		`## Vizier run stats (last ${s.total})`,
		``,
		`**Pass rate:** ${passRate !== null ? passRate + '%' : 'n/a'} (${s.passed} ok, ${s.failed} failed)`,
		`**Avg duration:** ${s.avg_duration_ms} ms`,
		`**Fallback rate:** ${s.fallback_rate}% (structured-output fallbacks to fenced parser)`,
		``,
		`**By kind:**`,
		kindLines || '  (none)',
		``,
		`**Top models:**`,
		modelLines || '  (none)',
	].join('\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rotateIfNeeded(file: string): void {
	try {
		const stat = fs.statSync(file);
		if (stat.size > MAX_BYTES) {
			fs.renameSync(file, file + '.1');
		}
	} catch { /* file doesn't exist yet — that's fine */ }
}
