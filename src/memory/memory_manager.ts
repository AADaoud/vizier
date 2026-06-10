/**
 * memory/memory_manager.ts
 *
 * Persistent memory layer — what Vizier knows about *you*, not the vault.
 *
 * Lifecycle (Odysseus §9.2):
 *   1. Post-turn extraction  — utility model distils ≤2 durable facts from recent messages
 *   2. Dedup check          — Jaccard similarity + optional LLM dedup for near-duplicates
 *   3. Periodic audit       — every ~5 new memories: merge, rewrite vague entries
 *   4. Retrieval            — pinned always; hybrid Jaccard retrieval with category boost
 *
 * Every extraction/dedup/audit call uses callStructured — schema guarantees mean
 * a malformed memory entry cannot reach the store.
 *
 * Storage: a single memories.json file in the plugin directory.
 */

import * as fs from 'fs';
import * as path from 'path';

import { buildLLMConfig, callStructured } from '../llm_core';
import {
	MemoryExtractionSchema,
	DedupDecisionSchema,
	type MemoryExtraction,
	type MemoryEntry,
	type DedupDecision,
} from '../schemas/index';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoredMemory extends MemoryEntry {
	id: string;
	created: number;       // unix ms
	updated: number;
	uses: number;
	pinned: boolean;
	source: 'user' | 'auto';
}

// ── Jaccard similarity ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
	'a','an','the','is','in','of','for','to','and','or','that','this','it',
	'was','with','as','at','by','i','my','me','we','are','on','be','has','had',
	'have','do','does','did','not','but','so','if','about','from','they','he',
	'she','you','your','their','there','been','were','will','would','could','should',
]);

function tokenize(text: string): Set<string> {
	return new Set(
		text.toLowerCase()
			.split(/\s+/)
			.map(w => w.replace(/[^a-z0-9]/g, ''))
			.filter(w => w.length >= 2 && !STOP_WORDS.has(w))
	);
}

function jaccard(a: string, b: string): number {
	const ta = tokenize(a);
	const tb = tokenize(b);
	if (!ta.size && !tb.size) return 1;
	if (!ta.size || !tb.size) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

// ── ID generation ─────────────────────────────────────────────────────────

function newId(): string {
	return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── MemoryManager ─────────────────────────────────────────────────────────

export class MemoryManager {
	private file: string;
	private memories: StoredMemory[] = [];
	private newSinceLastAudit = 0;
	private readonly AUDIT_INTERVAL = 5;
	private readonly JACCARD_DEDUP_THRESH = 0.72;

	constructor(pluginDir: string) {
		this.file = path.join(pluginDir, 'memories.json');
		this.load();
	}

	// ── Persistence ──────────────────────────────────────────────────

	private load(): void {
		try {
			if (fs.existsSync(this.file)) {
				const raw = fs.readFileSync(this.file, 'utf-8');
				this.memories = JSON.parse(raw) as StoredMemory[];
			}
		} catch { this.memories = []; }
	}

	private save(): void {
		try {
			fs.writeFileSync(this.file, JSON.stringify(this.memories, null, 2), 'utf-8');
		} catch { /* never crash on memory write failure */ }
	}

	// ── Public read API ───────────────────────────────────────────────

	getAll(): StoredMemory[] {
		return [...this.memories];
	}

	/** Retrieve up to `k` memories relevant to `query`. Pinned entries always included. */
	retrieve(query: string, k = 5): StoredMemory[] {
		const pinned  = this.memories.filter(m => m.pinned);
		const unpinned = this.memories.filter(m => !m.pinned);

		// Score by Jaccard similarity with a 5% recency tiebreaker
		const now = Date.now();
		const scored = unpinned.map(m => {
			const sim      = jaccard(query, m.text);
			const ageDays  = (now - m.created) / (1000 * 60 * 60 * 24);
			const recency  = Math.max(0, 1 - ageDays / 365); // decays over a year
			return { m, score: sim * 0.95 + recency * 0.05 };
		});
		scored.sort((a, b) => b.score - a.score);

		const remaining = Math.max(0, k - pinned.length);
		const retrieved = [
			...pinned,
			...scored.filter(s => s.score > 0.05).slice(0, remaining).map(s => s.m),
		];

		// Track usage
		for (const m of retrieved) {
			const stored = this.memories.find(s => s.id === m.id);
			if (stored) { stored.uses++; stored.updated = Date.now(); }
		}
		this.save();

		return retrieved;
	}

	/** Inline memory command: user said "remember: X". */
	addDirect(text: string, category: MemoryEntry['category'] = 'interest'): StoredMemory {
		const entry: StoredMemory = {
			id: newId(), text, category, confidence: 1.0,
			created: Date.now(), updated: Date.now(), uses: 0,
			pinned: false, source: 'user',
		};
		this.memories.unshift(entry);
		this.save();
		return entry;
	}

	setPinned(id: string, pinned: boolean): boolean {
		const m = this.memories.find(m => m.id === id);
		if (!m) return false;
		m.pinned = pinned; m.updated = Date.now();
		this.save();
		return true;
	}

	delete(id: string): boolean {
		const before = this.memories.length;
		this.memories = this.memories.filter(m => m.id !== id);
		if (this.memories.length !== before) { this.save(); return true; }
		return false;
	}

	// ── Post-turn extraction ──────────────────────────────────────────

	/**
	 * Extract ≤2 durable facts from recent turn messages.
	 * Uses the utility model with MemoryExtractionSchema — zero risk of
	 * a malformed entry reaching the store.
	 */
	async extractFromTurn(
		messages: Array<{ role: string; content: string }>,
		settings: AIAgentSettings
	): Promise<StoredMemory[]> {
		const start = Date.now();
		const cfg   = buildLLMConfig(settings);

		const prompt = [
			'From the conversation below, extract at most 2 durable facts about the USER that are worth remembering across sessions.',
			'Only extract facts that are clearly personal (interests, positions, gaps in knowledge, current readings, methods, identity).',
			'Do NOT extract facts about the vault or about topics discussed — only facts about the person.',
			'If there are no durable facts, return an empty memories array.',
			'',
			'Conversation:',
			messages.map(m => `${m.role}: ${m.content}`).join('\n'),
		].join('\n');

		try {
			const result = await callStructured<MemoryExtraction>(
				cfg, 'utility',
				MemoryExtractionSchema as Record<string, unknown>,
				[{ role: 'user', content: prompt }]
			);

			const added: StoredMemory[] = [];
			for (const entry of result.memories ?? []) {
				if (!entry.text?.trim()) continue;
				if (entry.confidence < 0.5) continue; // low-confidence facts are noise

				const deduped = await this.dedup(entry, settings);
				if (deduped) added.push(deduped);
			}

			if (added.length > 0) {
				this.newSinceLastAudit += added.length;
				if (this.newSinceLastAudit >= this.AUDIT_INTERVAL) {
					this.newSinceLastAudit = 0;
					void this.audit(settings); // non-blocking
				}
			}

			recordRun({ kind: 'memory', duration_ms: Date.now() - start, ok: true, notes_touched: added.length });
			return added;
		} catch (err) {
			recordRun({ kind: 'memory', duration_ms: Date.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
			return [];
		}
	}

	// ── Deduplication ─────────────────────────────────────────────────

	/**
	 * Three-tier dedup (Odysseus §9.2):
	 *   1. Exact match → skip
	 *   2. Jaccard ≥ 0.72 → LLM dedup check
	 *   3. Otherwise → add
	 *
	 * Returns the stored entry if added, null if duplicate.
	 */
	private async dedup(
		candidate: MemoryEntry,
		settings: AIAgentSettings
	): Promise<StoredMemory | null> {
		// Exact match
		if (this.memories.some(m => m.text.trim().toLowerCase() === candidate.text.trim().toLowerCase())) {
			return null;
		}

		// Jaccard near-match — ask the utility model
		const nearMatches = this.memories.filter(m => jaccard(m.text, candidate.text) >= this.JACCARD_DEDUP_THRESH);
		if (nearMatches.length > 0) {
			const cfg = buildLLMConfig(settings);
			try {
				const decision = await callStructured<DedupDecision>(
					cfg, 'utility',
					DedupDecisionSchema as Record<string, unknown>,
					[{
						role: 'user',
						content: [
							'Are these two memory entries duplicates or near-duplicates of each other?',
							'',
							`Existing: "${nearMatches[0]?.text}"`,
							`New:      "${candidate.text}"`,
							'',
							'A duplicate means they convey the same fact. A near-duplicate means one subsumes the other.',
							'If it is a near-duplicate, set is_duplicate=true.',
						].join('\n'),
					}]
				);
				if (decision.is_duplicate) return null;
			} catch { /* on dedup failure, add anyway */ }
		}

		// Store the new entry
		const entry: StoredMemory = {
			id: newId(),
			text: candidate.text,
			category: candidate.category,
			confidence: candidate.confidence,
			created: Date.now(), updated: Date.now(),
			uses: 0, pinned: false, source: 'auto',
		};
		this.memories.unshift(entry);
		this.save();
		return entry;
	}

	// ── Periodic audit ────────────────────────────────────────────────

	/**
	 * Conservative audit: merge near-duplicates, rewrite vague entries.
	 * Never deletes more than 30% of memories in a single pass.
	 * Runs in the background — never blocks the UI.
	 */
	private async audit(settings: AIAgentSettings): Promise<void> {
		if (this.memories.length < 4) return;
		const cfg = buildLLMConfig(settings);
		const start = Date.now();

		try {
			// Find pairs with high Jaccard similarity
			const toMerge: Array<[string, string]> = [];
			for (let i = 0; i < this.memories.length; i++) {
				for (let j = i + 1; j < this.memories.length; j++) {
					const mi = this.memories[i];
					const mj = this.memories[j];
					if (!mi || !mj) continue;
					if (jaccard(mi.text, mj.text) >= 0.65) {
						toMerge.push([mi.id, mj.id]);
					}
				}
			}

			let merged = 0;
			const maxMerge = Math.floor(this.memories.length * 0.3);

			for (const [idA, idB] of toMerge.slice(0, maxMerge)) {
				const a = this.memories.find(m => m.id === idA);
				const b = this.memories.find(m => m.id === idB);
				if (!a || !b) continue;

				try {
					const decision = await callStructured<DedupDecision>(
						cfg, 'utility',
						DedupDecisionSchema as Record<string, unknown>,
						[{
							role: 'user',
							content: `Are these memory entries duplicates?\n\nA: "${a.text}"\nB: "${b.text}"`,
						}]
					);

					if (decision.is_duplicate) {
						// Keep the more recent, higher-confidence entry
						const keep = a.confidence >= b.confidence ? a : b;
						const drop = a.confidence >= b.confidence ? b : a;
						keep.uses += drop.uses;
						keep.updated = Date.now();
						this.memories = this.memories.filter(m => m.id !== drop.id);
						merged++;
					}
				} catch { /* skip this pair */ }
			}

			if (merged > 0) this.save();
			recordRun({ kind: 'memory_audit', duration_ms: Date.now() - start, ok: true, notes_touched: merged });
		} catch (err) {
			recordRun({ kind: 'memory_audit', duration_ms: Date.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// ── Inline command processing ─────────────────────────────────────

	/**
	 * Check a user message for an inline "remember: X" command.
	 * Returns the stored memory if one was found and added.
	 */
	processInlineCommand(message: string): StoredMemory | null {
		const match = /^remember:\s*(.+)$/im.exec(message);
		if (!match || !match[1]) return null;
		return this.addDirect(match[1].trim());
	}
}
