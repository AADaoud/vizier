/**
 * epistemic/claims.ts
 *
 * Claims as first-class objects — Phase 3.1.
 *
 * A claim is a discrete factual assertion attached to the note that asserts
 * it, stored in YAML frontmatter under `claims:`. This makes the vault's
 * epistemic state machine-readable: the contradiction engine, /gaps, and the
 * verifier all operate on claims, not prose.
 *
 * Lifecycle: active → contested (a contradiction or user contests it)
 *                   → retracted (user decides it was wrong)
 *
 * All frontmatter mutation goes through Obsidian's processFrontMatter so we
 * never hand-parse YAML.
 */

import type { App, TFile } from 'obsidian';
import { buildLLMConfig, callStructured } from '../llm_core';
import { ClaimListSchema, type ClaimList } from '../schemas/index';
import type { AIAgentSettings } from '../settings';

// ── Types ──────────────────────────────────────────────────────────────────

/** Provenance tiers, strongest to weakest evidence chain. */
export type ClaimProvenance = 'primary' | 'secondary' | 'model' | 'user';

export interface NoteClaim {
	id: string;
	text: string;
	status: 'active' | 'contested' | 'retracted';
	confidence: number;
	sources: string[];
	created: string;          // YYYY-MM-DD
	provenance: ClaimProvenance;
	contested_reason?: string;
}

export interface VaultClaim {
	claim: NoteClaim;
	file: TFile;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function newClaimId(): string {
	return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Find a note by basename (case-insensitive) or vault path. */
export function findNote(app: App, name: string): TFile | null {
	const files = app.vault.getMarkdownFiles();
	return files.find(f =>
		f.basename.toLowerCase() === name.toLowerCase() ||
		f.path === name ||
		f.path === name + '.md'
	) ?? null;
}

function isClaimArray(v: unknown): v is NoteClaim[] {
	return Array.isArray(v) && v.every(c => typeof c === 'object' && c !== null && 'id' in c && 'text' in c);
}

// ── Read API ───────────────────────────────────────────────────────────────

/** Read the claims array from a note's frontmatter cache (no file I/O). */
export function getClaims(app: App, file: TFile): NoteClaim[] {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const raw = fm?.['claims'] as unknown;
	return isClaimArray(raw) ? raw : [];
}

/** All claims across the vault, with their owning files. */
export function getAllClaims(app: App, statuses: Array<NoteClaim['status']> = ['active', 'contested']): VaultClaim[] {
	const out: VaultClaim[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		for (const claim of getClaims(app, file)) {
			if (statuses.includes(claim.status)) out.push({ claim, file });
		}
	}
	return out;
}

// ── Write API ──────────────────────────────────────────────────────────────

/** Append a new claim to a note's frontmatter. Returns the stored claim. */
export async function addClaim(
	app: App,
	file: TFile,
	text: string,
	confidence = 0.7,
	sources: string[] = [],
	provenance: ClaimProvenance = 'user'
): Promise<NoteClaim> {
	const claim: NoteClaim = {
		id: newClaimId(),
		text: text.trim(),
		status: 'active',
		confidence: Math.max(0, Math.min(1, confidence)),
		sources,
		created: todayISO(),
		provenance,
	};
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const existing = isClaimArray(fm['claims']) ? fm['claims'] : [];
		fm['claims'] = [...existing, claim];
	});
	return claim;
}

/** Attach a source to an existing claim. Returns the updated claim or null. */
export async function citeClaim(
	app: App,
	file: TFile,
	claimId: string,
	source: string
): Promise<NoteClaim | null> {
	let updated: NoteClaim | null = null;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (!isClaimArray(fm['claims'])) return;
		fm['claims'] = fm['claims'].map(c => {
			if (c.id !== claimId) return c;
			updated = { ...c, sources: [...c.sources, source] };
			return updated;
		});
	});
	return updated;
}

/** Mark a claim contested with a reason. Returns the updated claim or null. */
export async function contestClaim(
	app: App,
	file: TFile,
	claimId: string,
	reason: string
): Promise<NoteClaim | null> {
	let updated: NoteClaim | null = null;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (!isClaimArray(fm['claims'])) return;
		fm['claims'] = fm['claims'].map(c => {
			if (c.id !== claimId) return c;
			updated = { ...c, status: 'contested' as const, contested_reason: reason };
			return updated;
		});
	});
	return updated;
}

// ── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract discrete factual claims from note text via the utility model.
 * Returns parsed claims (not yet stored — caller decides which to add).
 */
export async function extractClaimsFromText(
	settings: AIAgentSettings,
	text: string,
	maxClaims = 5
): Promise<ClaimList> {
	const cfg = buildLLMConfig(settings);
	return callStructured<ClaimList>(
		cfg, 'utility',
		ClaimListSchema as Record<string, unknown>,
		[{
			role: 'user',
			content: [
				`Extract up to ${maxClaims} discrete factual claims from the text below.`,
				'A claim is a single checkable assertion (who/what/when/where), not an opinion or a summary.',
				'For each claim, estimate confidence (0-1) that the text actually asserts it, and list any sources the text cites for it (empty array if none).',
				'',
				'Text:',
				text.slice(0, 8000),
			].join('\n'),
		}]
	);
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatClaims(claims: NoteClaim[]): string {
	if (claims.length === 0) return 'No claims recorded on this note.';
	return claims.map(c => {
		const statusBadge = c.status === 'active' ? '' : ` [${c.status.toUpperCase()}]`;
		const src = c.sources.length ? ` — sources: ${c.sources.join('; ')}` : ' — uncited';
		const prov = c.provenance ? ` [${c.provenance}]` : '';
		return `- \`${c.id}\`${statusBadge}${prov} (${Math.round(c.confidence * 100)}%) ${c.text}${src}`;
	}).join('\n');
}
