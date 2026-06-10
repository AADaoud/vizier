/**
 * epistemic/contradiction_engine.ts
 *
 * Background contradiction detection — Phase 3.2.
 *
 * Pipeline per scan:
 *   1. Gather all active/contested claims from frontmatter across the vault
 *   2. Embed each claim text (embedding role)
 *   3. Candidate pairs = cross-note pairs with cosine ≥ CANDIDATE_THRESH
 *      (claims about unrelated things can't contradict; only near-neighbours can)
 *   4. For each candidate (capped per scan): structured contradiction check
 *   5. medium/high severity → flag note written to the contradictions folder
 *
 * Already-checked pairs are remembered in contradiction_state.json in the
 * plugin dir so repeat scans don't re-bill the same comparisons.
 *
 * Invariant: this writes ONLY to the contradictions folder — never touches
 * the user's own notes.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { App } from 'obsidian';
import { buildLLMConfig, callStructured, getEmbedding, cosineSimilarity } from '../llm_core';
import { ContradictionReportSchema, type ContradictionReport } from '../schemas/index';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';
import { getAllClaims, type VaultClaim } from './claims';
import { ensureFolder, sanitizeFilename, deduplicatePath } from '../utils/noteBuilder';

// ── Tuning ─────────────────────────────────────────────────────────────────

const CANDIDATE_THRESH   = 0.60; // cosine floor for "claims about the same thing"
const MAX_PAIRS_PER_SCAN = 10;   // LLM checks per scan — keep scans cheap
const MAX_CLAIMS_EMBED   = 200;  // safety cap for huge vaults

// ── Seen-pair state ────────────────────────────────────────────────────────

interface ScanState {
	checked: string[]; // sorted "idA|idB" keys already LLM-checked
}

function statePath(pluginDir: string): string {
	return path.join(pluginDir, 'contradiction_state.json');
}

function loadState(pluginDir: string): ScanState {
	try {
		const raw = fs.readFileSync(statePath(pluginDir), 'utf-8');
		return JSON.parse(raw) as ScanState;
	} catch { return { checked: [] }; }
}

function saveState(pluginDir: string, state: ScanState): void {
	try {
		fs.writeFileSync(statePath(pluginDir), JSON.stringify(state), 'utf-8');
	} catch { /* best-effort */ }
}

function pairKey(a: string, b: string): string {
	return [a, b].sort().join('|');
}

// ── Scan ───────────────────────────────────────────────────────────────────

export interface ScanResult {
	claims: number;
	candidates: number;
	checked: number;
	flagged: number;
}

export async function runContradictionScan(
	app: App,
	settings: AIAgentSettings,
	pluginDir: string
): Promise<ScanResult> {
	const start = Date.now();
	const cfg   = buildLLMConfig(settings);
	const state = loadState(pluginDir);
	const seen  = new Set(state.checked);

	const all = getAllClaims(app).slice(0, MAX_CLAIMS_EMBED);
	const result: ScanResult = { claims: all.length, candidates: 0, checked: 0, flagged: 0 };
	if (all.length < 2) {
		recordRun({ kind: 'contradiction_scan', duration_ms: Date.now() - start, ok: true, ...result });
		return result;
	}

	// Embed every claim (cheap: short texts, local model)
	const vectors: Array<number[] | null> = [];
	for (const vc of all) {
		try {
			const { vector } = await getEmbedding(cfg, vc.claim.text);
			vectors.push(vector);
		} catch { vectors.push(null); }
	}

	// Cross-note candidate pairs above the similarity floor, best-first
	const candidates: Array<{ a: VaultClaim; b: VaultClaim; sim: number }> = [];
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const a = all[i], b = all[j];
			const va = vectors[i], vb = vectors[j];
			if (!a || !b || !va || !vb) continue;
			if (a.file.path === b.file.path) continue; // same-note tension is the author's business
			if (seen.has(pairKey(a.claim.id, b.claim.id))) continue;
			const sim = cosineSimilarity(va, vb);
			if (sim >= CANDIDATE_THRESH) candidates.push({ a, b, sim });
		}
	}
	candidates.sort((x, y) => y.sim - x.sim);
	result.candidates = candidates.length;

	for (const { a, b } of candidates.slice(0, MAX_PAIRS_PER_SCAN)) {
		result.checked++;
		seen.add(pairKey(a.claim.id, b.claim.id));

		let report: ContradictionReport;
		try {
			report = await callStructured<ContradictionReport>(
				cfg, 'utility',
				ContradictionReportSchema as Record<string, unknown>,
				[{
					role: 'user',
					content: [
						'Do these two claims from different notes contradict each other?',
						'If they are compatible, complementary, or merely about the same topic, set tension_type to "none".',
						'Only report a real logical tension — be conservative.',
						'',
						`Claim A (from note "${a.file.basename}"): ${a.claim.text}`,
						`Claim B (from note "${b.file.basename}"): ${b.claim.text}`,
					].join('\n'),
				}]
			);
		} catch { continue; }

		if (report.tension_type === 'none' || report.severity === 'low') continue;

		try {
			await writeFlagNote(app, settings, a, b, report);
			result.flagged++;
		} catch { /* folder problems — skip, don't crash the scan */ }
	}

	state.checked = [...seen].slice(-5000); // bound the state file
	saveState(pluginDir, state);

	recordRun({ kind: 'contradiction_scan', duration_ms: Date.now() - start, ok: true, ...result });
	return result;
}

// ── Flag note ──────────────────────────────────────────────────────────────

async function writeFlagNote(
	app: App,
	settings: AIAgentSettings,
	a: VaultClaim,
	b: VaultClaim,
	report: ContradictionReport
): Promise<void> {
	const folder = settings.contradictionsFolder || 'Vizier/Contradictions';
	await ensureFolder(app, folder);

	const title = `Contradiction - ${a.file.basename} vs ${b.file.basename}`;
	const base  = `${folder}/${sanitizeFilename(title)}`;
	const notePath = await deduplicatePath(app, base);

	const content = [
		'---',
		'type: contradiction',
		'status: open',
		`severity: ${report.severity}`,
		`tension: ${report.tension_type}`,
		`created: ${new Date().toISOString().slice(0, 10)}`,
		`claim_ids: [${a.claim.id}, ${b.claim.id}]`,
		'---',
		'',
		`# Contradiction: [[${a.file.basename}]] vs [[${b.file.basename}]]`,
		'',
		`> [!warning] ${report.tension_type.replace(/_/g, ' ')} — ${report.severity} severity`,
		'',
		`**Claim A** (from [[${a.file.basename}]]):`,
		`> ${a.claim.text}`,
		'',
		`**Claim B** (from [[${b.file.basename}]]):`,
		`> ${b.claim.text}`,
		'',
		'## Why these conflict',
		'',
		report.explanation,
		'',
		'## Resolution',
		'',
		'- [ ] Investigated — which claim survives?',
		'- [ ] Update the losing note (or contest its claim) and set `status: resolved` above.',
		'',
	].join('\n');

	await app.vault.create(notePath, content);
}
