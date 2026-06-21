/**
 * memory/vault_index.ts
 *
 * Hybrid vault search index — Phase 2.1.
 *
 * Algorithm (Odysseus §retrieval stack adapted for TypeScript/Obsidian):
 *   hybrid_score = 0.7 × vector_similarity + 0.3 × bm25_score
 *   threshold ≈ 0.35, k = 5, 10K-char injection cap
 *
 * Architecture:
 *   - Chunk notes by heading (H2/H3 sections), fall back to ~400-char windows
 *   - Embed each chunk via Ollama's embedding API (embedding role)
 *   - Persist index as {path, chunk_id, text_hash, vector, text} in vault_index.json
 *   - Incremental update on Obsidian vault modify/create/delete events (hash-deduped)
 *   - BM25 scores are computed at query time (no pre-built inverted index needed at this scale)
 *
 * The index lives in the plugin directory, not the vault, so it won't appear
 * as a note in the user's workspace.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { App, TFile } from 'obsidian';
import { buildLLMConfig, getEmbedding, cosineSimilarity } from '../llm_core';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';

// Stop a reindex after this many consecutive chunk-embedding failures — the
// embedding host is effectively down, so further attempts only waste time.
const ABORT_AFTER_CONSECUTIVE_FAILURES = 12;

// During a full reindex, flush to disk every N files instead of after every
// file. Writing the whole index per-file is O(n²) IO and blocks the UI; a
// periodic flush (plus a final save) keeps progress durable without the storm.
const SAVE_EVERY_FILES = 50;

// Embedding vectors are stored at full f64 precision (~17 digits/number), which
// dominates the file size. 6 decimals is far more than cosine similarity needs
// and roughly halves the on-disk size and serialization cost.
function roundVector(v: number[]): number[] {
	return v.map(x => Math.round(x * 1e6) / 1e6);
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface IndexChunk {
	path: string;       // vault file path
	basename: string;
	chunk_id: string;   // `${path}#${chunkIndex}`
	text_hash: string;  // sha-ish: first 12 chars of btoa(text)
	text: string;
	vector: number[];
	indexed_at: number; // unix ms
}

export interface SearchResult {
	chunk: IndexChunk;
	score: number;
	vector_score: number;
	bm25_score: number;
}

export interface ReindexStats {
	files: number;
	chunksAdded: number;
	embedFailures: number;
	/** True when the run was stopped early because embeddings kept failing. */
	aborted: boolean;
}

// ── BM25 implementation ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
	'a','an','the','is','in','of','for','to','and','or','that','this','it',
	'was','with','as','at','by','i','my','me','we','are','on','be','has','had',
	'have','do','does','did','not','but','so','if','about','from',
]);

function tokenize(text: string): string[] {
	return text.toLowerCase()
		.split(/\s+/)
		.map(w => w.replace(/[^a-z0-9]/g, ''))
		.filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

function textHash(text: string): string {
	// Simple non-cryptographic hash — just for dedup checks
	return btoa(text.slice(0, 64)).slice(0, 12);
}

interface BM25Corpus {
	df: Map<string, number>;    // document frequency per term
	docCount: number;
	avgDocLen: number;
}

function buildBM25Corpus(chunks: IndexChunk[]): BM25Corpus {
	const df = new Map<string, number>();
	let totalLen = 0;

	for (const chunk of chunks) {
		const terms = new Set(tokenize(chunk.text));
		totalLen += terms.size;
		for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
	}

	return { df, docCount: chunks.length, avgDocLen: chunks.length ? totalLen / chunks.length : 1 };
}

function bm25Score(query: string, docText: string, corpus: BM25Corpus, k1 = 1.5, b = 0.75): number {
	const queryTerms = tokenize(query);
	const docTokens  = tokenize(docText);
	const docLen     = docTokens.length;
	const tf = new Map<string, number>();
	for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

	let score = 0;
	for (const qt of queryTerms) {
		const termTF  = tf.get(qt) ?? 0;
		if (termTF === 0) continue;
		const df      = corpus.df.get(qt) ?? 0;
		const idf     = Math.log((corpus.docCount - df + 0.5) / (df + 0.5) + 1);
		const tfNorm  = (termTF * (k1 + 1)) / (termTF + k1 * (1 - b + b * (docLen / corpus.avgDocLen)));
		score += idf * tfNorm;
	}
	return score;
}

// ── Chunking ──────────────────────────────────────────────────────────────

function chunkByHeadings(text: string, maxChars = 600): string[] {
	// Split on H2/H3 headings
	const sections = text.split(/\n(?=##\s)/);
	const chunks: string[] = [];

	for (const section of sections) {
		if (section.length <= maxChars) {
			chunks.push(section.trim());
		} else {
			// Further split large sections into ~maxChars windows with 100-char overlap
			let pos = 0;
			while (pos < section.length) {
				chunks.push(section.slice(pos, pos + maxChars).trim());
				pos += maxChars - 100;
			}
		}
	}

	return chunks.filter(c => c.length > 50); // drop tiny fragments
}

// ── VaultIndex ────────────────────────────────────────────────────────────

export class VaultIndex {
	private storePath: string;
	private chunks: IndexChunk[] = [];
	/** chunk_id → chunk, for O(1) lookups during (re)indexing. */
	private byId = new Map<string, IndexChunk>();
	private dirty = false;
	/** Resolves once the on-disk index has finished loading. */
	private readonly ready: Promise<void>;

	constructor(pluginDir: string) {
		this.storePath = path.join(pluginDir, 'vault_index.json');
		// Load asynchronously so a large index file doesn't block plugin onload
		// (and thus Obsidian launch). Public methods await `ready` before use.
		this.ready = this.load();
	}

	// ── Persistence ──────────────────────────────────────────────────

	private async load(): Promise<void> {
		try {
			const raw = await fs.promises.readFile(this.storePath, 'utf-8');
			this.chunks = JSON.parse(raw) as IndexChunk[];
		} catch { this.chunks = []; } // missing file or parse error → start empty
		this.byId = new Map(this.chunks.map(c => [c.chunk_id, c]));
	}

	private saving = false;
	private savePending = false;

	/**
	 * Persist the index without blocking the main thread (async write). Calls are
	 * coalesced: if a save is already running, the latest state is flushed once it
	 * finishes, so overlapping callers never corrupt the file with interleaved writes.
	 */
	private async save(): Promise<void> {
		if (this.saving) { this.savePending = true; return; }
		this.saving = true;
		try {
			do {
				this.savePending = false;
				const data = JSON.stringify(this.chunks); // synchronous snapshot
				this.dirty = false;
				await fs.promises.writeFile(this.storePath, data, 'utf-8');
			} while (this.savePending);
		} catch { /* best-effort */ } finally {
			this.saving = false;
		}
	}

	// ── Index management ─────────────────────────────────────────────

	/** Remove all chunks for a given file path. */
	async removeFile(filePath: string): Promise<void> {
		await this.ready;
		const before = this.chunks.length;
		this.chunks = this.chunks.filter(c => {
			if (c.path === filePath) { this.byId.delete(c.chunk_id); return false; }
			return true;
		});
		if (this.chunks.length !== before) this.dirty = true;
	}

	/**
	 * Index or re-index a single file. Skips chunks whose text_hash hasn't changed.
	 * Pass defer=true during a batch reindex to skip the per-file disk write (the
	 * caller flushes periodically) — avoids rewriting the whole index per file.
	 */
	async indexFile(file: TFile, app: App, settings: AIAgentSettings, defer = false): Promise<{ added: number; failed: number }> {
		await this.ready;
		const content = await app.vault.cachedRead(file);
		// Strip YAML frontmatter from indexing (the metadata is in frontmatter cache)
		const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
		if (body.length < 100) return { added: 0, failed: 0 }; // too short to index

		const rawChunks = chunkByHeadings(body);
		const cfg       = buildLLMConfig(settings);
		let added = 0;
		let failed = 0;

		for (let i = 0; i < rawChunks.length; i++) {
			const text = rawChunks[i] ?? '';
			const hash = textHash(text);
			const id   = `${file.path}#${i}`;

			// Skip if unchanged
			const existing = this.byId.get(id);
			if (existing?.text_hash === hash) continue;

			try {
				const { vector } = await getEmbedding(cfg, text);
				const chunk: IndexChunk = {
					path: file.path,
					basename: file.basename,
					chunk_id: id,
					text_hash: hash,
					text,
					vector: roundVector(vector),
					indexed_at: Date.now(),
				};

				if (existing) {
					Object.assign(existing, chunk);
				} else {
					this.chunks.push(chunk);
					this.byId.set(id, chunk);
				}
				this.dirty = true;
				added++;
			} catch (err) {
				failed++;
				if (failed === 1) console.warn('[Vizier] chunk embedding failed:', err);
			}
		}

		if (!defer && this.dirty) await this.save();
		return { added, failed };
	}

	/** Full incremental re-index of the vault. Processes only changed/new files.
	 *  Throws with a clear message when the embedding model is unavailable. */
	async reindexVault(app: App, settings: AIAgentSettings, onProgress?: (done: number, total: number) => void): Promise<ReindexStats> {
		await this.ready;
		const start = Date.now();
		const cfg   = buildLLMConfig(settings);

		// Pre-flight: fail loudly (not per-chunk-silently) if embeddings are down
		try {
			await getEmbedding(cfg, 'vizier embedding pre-flight test');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			recordRun({ kind: 'vault_index', duration_ms: Date.now() - start, ok: false, error: msg });
			throw new Error(`Embedding unavailable — vault index cannot build. ${msg}`);
		}

		const files = app.vault.getMarkdownFiles();
		let chunksAdded   = 0;
		let embedFailures = 0;
		let consecutiveFailures = 0; // resets on any successful chunk
		let aborted = false;

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) continue;
			try {
				onProgress?.(i, files.length);
				// defer=true: don't rewrite the whole index after every file.
				const r = await this.indexFile(file, app, settings, true);
				chunksAdded   += r.added;
				embedFailures += r.failed;
				if (r.added > 0)      consecutiveFailures = 0;
				else if (r.failed > 0) consecutiveFailures += r.failed;
			} catch { embedFailures++; consecutiveFailures++; }

			// Periodic flush so progress survives a crash without per-file IO.
			if (this.dirty && (i + 1) % SAVE_EVERY_FILES === 0) {
				await this.save();
				// Yield to the event loop so the UI stays responsive during a big build.
				await new Promise(resolve => setTimeout(resolve, 0));
			}

			// Circuit-breaker: if embeddings keep failing, stop rather than
			// grinding through (and log-spamming) every remaining file.
			if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
				aborted = true;
				break;
			}
		}

		if (this.dirty) await this.save();
		// A completed run is a success even if some chunks failed — only an
		// early abort (embeddings effectively down) counts as a failed run.
		recordRun({ kind: 'vault_index', duration_ms: Date.now() - start, ok: !aborted, notes_touched: files.length, chunks_added: chunksAdded, embed_failures: embedFailures, aborted });
		return { files: files.length, chunksAdded, embedFailures, aborted };
	}

	// ── Search ────────────────────────────────────────────────────────

	/**
	 * Hybrid search: 0.7 × cosine(vector) + 0.3 × BM25.
	 * Returns up to `k` chunks above the threshold.
	 */
	async search(
		query: string,
		settings: AIAgentSettings,
		k = 5,
		threshold = 0.35
	): Promise<SearchResult[]> {
		await this.ready;
		if (this.chunks.length === 0) return [];

		const cfg    = buildLLMConfig(settings);
		const corpus = buildBM25Corpus(this.chunks);

		// Get query embedding
		let queryVector: number[];
		try {
			const { vector } = await getEmbedding(cfg, query);
			queryVector = vector;
		} catch {
			// Embedding failed — fall back to BM25-only
			return this.bm25OnlySearch(query, corpus, k, threshold);
		}

		// Score all chunks
		const maxBM25 = Math.max(...this.chunks.map(c => bm25Score(query, c.text, corpus))) || 1;

		const results: SearchResult[] = this.chunks.map(chunk => {
			const vector_score = chunk.vector.length === queryVector.length
				? cosineSimilarity(queryVector, chunk.vector)
				: 0;
			const raw_bm25    = bm25Score(query, chunk.text, corpus);
			const bm25_score  = raw_bm25 / maxBM25; // normalize to [0,1]
			const score       = 0.7 * vector_score + 0.3 * bm25_score;
			return { chunk, score, vector_score, bm25_score };
		});

		return results
			.filter(r => r.score >= threshold)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	private bm25OnlySearch(query: string, corpus: BM25Corpus, k: number, threshold: number): SearchResult[] {
		const maxBM25 = Math.max(...this.chunks.map(c => bm25Score(query, c.text, corpus))) || 1;
		return this.chunks
			.map(chunk => {
				const raw = bm25Score(query, chunk.text, corpus);
				const norm = raw / maxBM25;
				return { chunk, score: norm, vector_score: 0, bm25_score: norm };
			})
			.filter(r => r.score >= threshold)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	/**
	 * Notes semantically nearest to a given note, scored against the centroid
	 * of its chunk vectors. Pure vector math over the stored index — no
	 * embedding calls, so it's cheap enough for interactive use.
	 */
	semanticNeighbors(notePath: string, k = 8): Array<{ path: string; basename: string; score: number }> {
		const own = this.chunks.filter(c => c.path === notePath && c.vector.length > 0);
		if (own.length === 0) return [];
		const dim = own[0]?.vector.length ?? 0;

		const centroid = new Array<number>(dim).fill(0);
		for (const c of own) {
			for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) + (c.vector[i] ?? 0);
		}
		for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) / own.length;

		const best = new Map<string, { basename: string; score: number }>();
		for (const c of this.chunks) {
			if (c.path === notePath || c.vector.length !== dim) continue;
			const s = cosineSimilarity(centroid, c.vector);
			const prev = best.get(c.path);
			if (!prev || s > prev.score) best.set(c.path, { basename: c.basename, score: s });
		}

		return [...best.entries()]
			.map(([p, v]) => ({ path: p, basename: v.basename, score: v.score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	/** Format search results as a markdown string for agent context injection. */
	formatResults(results: SearchResult[], cap = 10_000): string {
		if (results.length === 0) return 'No relevant vault chunks found.';
		let out = '';
		for (const r of results) {
			const snippet = r.chunk.text.slice(0, 400);
			const line = `**[[${r.chunk.basename}]]** (score: ${r.score.toFixed(2)})\n${snippet}\n\n`;
			if (out.length + line.length > cap) break;
			out += line;
		}
		return out.trim();
	}

	getStats(): { total_chunks: number; total_files: number } {
		const files = new Set(this.chunks.map(c => c.path));
		return { total_chunks: this.chunks.length, total_files: files.size };
	}
}
