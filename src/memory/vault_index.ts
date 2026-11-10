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
 *   - Persist index as {path, chunk_id, text_hash, model, vector, text} in vault_index.json
 *   - Incremental update on Obsidian vault modify/create/delete events: each
 *     file is re-indexed as a whole, one run at a time per path. Chunks whose
 *     full-text hash and embedding model are unchanged are reused; the rest are
 *     re-embedded, and chunks no longer in the note are dropped.
 *   - BM25 scores are computed at query time (no pre-built inverted index needed at this scale)
 *
 * The index lives in the plugin directory, not the vault, so it won't appear
 * as a note in the user's workspace.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { App, TFile } from 'obsidian';
import { buildLLMConfig, getEmbedding, cosineSimilarity } from '../llm_core';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';

// Stop a reindex after this many consecutive chunk-embedding failures — the
// embedding host is effectively down, so further attempts only waste time.
// Only embedding errors count: a file that cannot be read says nothing about
// the embedding host.
const ABORT_AFTER_CONSECUTIVE_FAILURES = 12;

// Notes whose body is shorter than this are not indexed.
const MIN_BODY_CHARS = 100;

// Editor autosaves fire `modify` every couple of seconds while typing. Wait for
// a pause before re-indexing so one editing burst costs one pass.
const INDEX_DEBOUNCE_MS = 2000;

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
	text_hash: string;  // textHash(text): covers the whole chunk, any Unicode
	/** Embedding model that produced `vector`. Absent on chunks written before 0.7.8. */
	model?: string;
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

/** Change-detection hash over the full chunk text. Accepts any Unicode. */
export function textHash(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

interface BM25Corpus {
	df: Map<string, number>;    // document frequency per term
	docCount: number;
	avgDocLen: number;
}

interface DocTerms {
	tf: Map<string, number>;    // term frequency within the chunk
	len: number;                // token count
}

// Tokenising a chunk is the expensive part of BM25, and a chunk's text never
// changes once created (an edit makes a new chunk object), so cache per chunk.
const docTermsCache = new WeakMap<IndexChunk, DocTerms>();

function docTerms(chunk: IndexChunk): DocTerms {
	let d = docTermsCache.get(chunk);
	if (!d) {
		const tokens = tokenize(chunk.text);
		const tf = new Map<string, number>();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		d = { tf, len: tokens.length };
		docTermsCache.set(chunk, d);
	}
	return d;
}

function buildBM25Corpus(chunks: IndexChunk[]): BM25Corpus {
	const df = new Map<string, number>();
	let totalLen = 0;

	for (const chunk of chunks) {
		const { tf } = docTerms(chunk);
		totalLen += tf.size;
		for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	}

	return { df, docCount: chunks.length, avgDocLen: chunks.length ? totalLen / chunks.length : 1 };
}

function bm25Score(queryTerms: string[], chunk: IndexChunk, corpus: BM25Corpus, k1 = 1.5, b = 0.75): number {
	const { tf, len: docLen } = docTerms(chunk);

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
	/** Cached BM25 corpus statistics; cleared whenever chunks change. */
	private corpus: BM25Corpus | null = null;
	/** Tail of the indexing work queued per path, so one file is never indexed twice at once. */
	private queues = new Map<string, Promise<unknown>>();
	/** Pending debounced re-index timers, per path. */
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Model name reported by the most recent successful embedding. */
	private currentModel: string | null = null;
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
		let raw: string | null = null;
		try {
			raw = await fs.promises.readFile(this.storePath, 'utf-8');
		} catch { /* missing file → start empty */ }

		this.chunks = [];
		if (raw !== null) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!Array.isArray(parsed)) throw new Error('index is not an array');
				this.chunks = parsed as IndexChunk[];
			} catch (err) {
				// Keep the unreadable file aside rather than letting the next
				// save overwrite it; the index rebuilds from the vault.
				const aside = `${this.storePath}.corrupt-${Date.now()}`;
				console.warn(`[Vizier] vault index unreadable, keeping it as ${path.basename(aside)}:`, err);
				try { await fs.promises.rename(this.storePath, aside); } catch { /* best-effort */ }
			}
		}
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
				// Write to a temp file, then rename: a crash mid-write leaves
				// the previous index intact instead of truncated JSON.
				const tmp = `${this.storePath}.tmp`;
				await fs.promises.writeFile(tmp, data, 'utf-8');
				await fs.promises.rename(tmp, this.storePath);
			} while (this.savePending);
		} catch (err) {
			this.dirty = true; // nothing reached disk; retry on the next save
			console.warn('[Vizier] vault index save failed:', err);
		} finally {
			this.saving = false;
		}
	}

	// ── Index management ─────────────────────────────────────────────

	/** Run `task` after any work already queued for `filePath` has finished. */
	private enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(filePath) ?? Promise.resolve();
		const run  = prev.then(task, task);
		const tail = run.catch(() => undefined);
		this.queues.set(filePath, tail);
		void tail.then(() => { if (this.queues.get(filePath) === tail) this.queues.delete(filePath); });
		return run;
	}

	/** Replace every chunk of `filePath` with `next` (empty = remove the file). */
	private replaceFileChunks(filePath: string, next: IndexChunk[]): void {
		this.chunks = this.chunks.filter(c => {
			if (c.path !== filePath) return true;
			this.byId.delete(c.chunk_id);
			return false;
		});
		for (const c of next) {
			this.chunks.push(c);
			this.byId.set(c.chunk_id, c);
		}
		this.dirty = true;
		this.corpus = null;
	}

	private cancelScheduled(filePath: string): void {
		const t = this.timers.get(filePath);
		if (t !== undefined) { clearTimeout(t); this.timers.delete(filePath); }
	}

	/** Remove all chunks for a given file path. */
	async removeFile(filePath: string): Promise<void> {
		this.cancelScheduled(filePath);
		await this.ready;
		await this.enqueue(filePath, async () => {
			if (!this.chunks.some(c => c.path === filePath)) return;
			this.replaceFileChunks(filePath, []);
			await this.save();
		});
	}

	/**
	 * Re-index a file once edits to it have paused. Use for vault events, which
	 * fire on every autosave; `indexFile` runs immediately.
	 */
	scheduleIndexFile(file: TFile, app: App, settings: AIAgentSettings, delayMs = INDEX_DEBOUNCE_MS): void {
		this.cancelScheduled(file.path);
		this.timers.set(file.path, setTimeout(() => {
			this.timers.delete(file.path);
			this.indexFile(file, app, settings).catch((err: unknown) => {
				console.warn(`[Vizier] indexing ${file.path} failed:`, err);
			});
		}, delayMs));
	}

	/** Cancel pending debounced work and flush unsaved changes (plugin unload). */
	async flush(): Promise<void> {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		await this.ready;
		if (this.dirty) await this.save();
	}

	/**
	 * Index or re-index a single file. Calls for the same path run one at a
	 * time. Chunks whose full text and embedding model are unchanged are reused
	 * without an embedding call; chunks no longer in the note are dropped.
	 * Pass defer=true during a batch reindex to skip the per-file disk write (the
	 * caller flushes periodically) — avoids rewriting the whole index per file.
	 */
	async indexFile(file: TFile, app: App, settings: AIAgentSettings, defer = false): Promise<{ added: number; failed: number }> {
		await this.ready;
		return this.enqueue(file.path, () => this.indexFileNow(file, app, settings, defer));
	}

	private async indexFileNow(file: TFile, app: App, settings: AIAgentSettings, defer: boolean): Promise<{ added: number; failed: number }> {
		const content = await app.vault.cachedRead(file);
		// Strip YAML frontmatter from indexing (the metadata is in frontmatter cache)
		const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
		const rawChunks = body.length < MIN_BODY_CHARS ? [] : chunkByHeadings(body);

		const old = this.chunks.filter(c => c.path === file.path);
		// Reuse by content, not position: inserting a section must not re-embed
		// everything after it. Identical chunks in one note share a vector.
		const reusable = new Map<string, IndexChunk>();
		for (const c of old) {
			if (this.currentModel === null || c.model === this.currentModel) reusable.set(c.text_hash, c);
		}

		const cfg  = buildLLMConfig(settings);
		const next: IndexChunk[] = [];
		let added = 0;
		let failed = 0;

		for (let i = 0; i < rawChunks.length; i++) {
			const text = rawChunks[i] ?? '';
			const hash = textHash(text);
			const id   = `${file.path}#${i}`;

			const kept = reusable.get(hash);
			if (kept) {
				next.push({ ...kept, basename: file.basename, chunk_id: id });
				continue;
			}

			try {
				const { vector, model } = await getEmbedding(cfg, text);
				this.currentModel = model;
				const chunk: IndexChunk = {
					path: file.path,
					basename: file.basename,
					chunk_id: id,
					text_hash: hash,
					model,
					text,
					vector: roundVector(vector),
					indexed_at: Date.now(),
				};
				reusable.set(hash, chunk);
				next.push(chunk);
				added++;
			} catch (err) {
				failed++;
				if (failed === 1) console.warn('[Vizier] chunk embedding failed:', err);
				// Keep what was at this position searchable until the embedding
				// succeeds; its stale hash makes the next pass retry it.
				const stale = old.find(c => c.chunk_id === id);
				if (stale) next.push(stale);
			}
		}

		const unchanged = added === 0 && next.length === old.length
			&& next.every((c, i) => c.chunk_id === old[i]?.chunk_id && c.text_hash === old[i]?.text_hash);
		if (!unchanged) this.replaceFileChunks(file.path, next);

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
			// Also learns the current embedding model, so chunks embedded by a
			// different model are re-embedded below.
			this.currentModel = (await getEmbedding(cfg, 'vizier embedding pre-flight test')).model;
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
				onProgress?.(i + 1, files.length);
				// defer=true: don't rewrite the whole index after every file.
				const r = await this.indexFile(file, app, settings, true);
				chunksAdded   += r.added;
				embedFailures += r.failed;
				if (r.added > 0)      consecutiveFailures = 0;
				else if (r.failed > 0) consecutiveFailures += r.failed;
			} catch (err) {
				// Not an embedding failure (e.g. the file could not be read):
				// skip the file without tripping the circuit-breaker.
				console.warn(`[Vizier] could not index ${file.path}:`, err);
			}

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

		const cfg = buildLLMConfig(settings);

		// BM25 once per chunk, with the corpus statistics cached between queries.
		const queryTerms = tokenize(query);
		const corpus     = this.bm25Corpus();
		const rawBM25    = this.chunks.map(c => bm25Score(queryTerms, c, corpus));
		const maxBM25    = rawBM25.reduce((m, x) => (x > m ? x : m), 0) || 1;

		// Get query embedding
		let queryVector: number[] | null = null;
		try {
			queryVector = (await getEmbedding(cfg, query)).vector;
		} catch { /* embedding failed — fall back to BM25-only below */ }

		const results: SearchResult[] = this.chunks.map((chunk, i) => {
			const bm25_score = (rawBM25[i] ?? 0) / maxBM25; // normalize to [0,1]
			if (!queryVector) return { chunk, score: bm25_score, vector_score: 0, bm25_score };
			const vector_score = chunk.vector.length === queryVector.length
				? cosineSimilarity(queryVector, chunk.vector)
				: 0;
			return { chunk, score: 0.7 * vector_score + 0.3 * bm25_score, vector_score, bm25_score };
		});

		return results
			.filter(r => r.score >= threshold)
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}

	/** Corpus statistics for BM25, rebuilt only after the index has changed. */
	private bm25Corpus(): BM25Corpus {
		if (!this.corpus) this.corpus = buildBM25Corpus(this.chunks);
		return this.corpus;
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
