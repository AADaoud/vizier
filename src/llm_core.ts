/**
 * llm_core.ts
 *
 * Single module that owns all Ollama traffic: role-based model routing,
 * fallback chains, capability detection, structured output, and streaming.
 *
 * Two call modes — never mix them:
 *   callStructured  → grammar-constrained JSON (temperature 0, code consumes output)
 *   callStreaming    → free-form prose stream with token callback (humans read output)
 */

import { requestUrl } from 'obsidian';
import type { AIAgentSettings, ModelRole } from './settings';

// ── Types ──────────────────────────────────────────────────────────────────

export interface LLMMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	images?: string[]; // base64 for vision
}

export interface LLMOptions {
	temperature?: number;
	num_predict?: number;
	stop?: string[];
}

export interface LLMCoreConfig {
	ollamaUrl: string;
	roles: Record<ModelRole, { models: string[]; endpoint?: string }>;
	/** num_ctx for local models; 0 = use the model's max. Cloud models ignore this. */
	localContextWindow: number;
}

// ── Build config from plugin settings ────────────────────────────────────

export function buildLLMConfig(settings: AIAgentSettings): LLMCoreConfig {
	// Backwards-compat: if roles field is missing from saved data, seed from defaultModel
	const saved = settings.roles ?? { default: { models: [] }, utility: { models: [] }, research: { models: [] }, embedding: { models: [] } };
	const fallback = settings.defaultModel || 'gemma3:4b';
	return {
		ollamaUrl: settings.ollamaUrl,
		roles: {
			default:   { models: saved.default?.models?.length   ? saved.default.models   : [fallback], endpoint: saved.default?.endpoint },
			utility:   { models: saved.utility?.models?.length   ? saved.utility.models   : [fallback], endpoint: saved.utility?.endpoint },
			research:  { models: saved.research?.models?.length  ? saved.research.models  : [fallback], endpoint: saved.research?.endpoint },
			embedding: { models: saved.embedding?.models?.length ? saved.embedding.models : ['nomic-embed-text'], endpoint: saved.embedding?.endpoint },
		},
		localContextWindow: settings.localContextWindow ?? 8192,
	};
}

// ── Cloud vs local models ───────────────────────────────────────────────────
// Ollama cloud models are named "<model>:cloud" or "<model>:<size>-cloud". The
// hosted provider manages context, so we never send num_ctx for them and use
// their full window. Local models honor only the num_ctx we pass at request
// time (Ollama's default is small), so we must set it explicitly.

export function isCloudModel(model: string): boolean {
	return /(?::|-)cloud$/.test(model.toLowerCase());
}

/**
 * The window we will actually use for a model:
 *   - cloud  → the model's full context_length (provider honors it)
 *   - local  → localContextWindow (clamped to the model's max); 0 = use the max
 * For local models this value is also sent as options.num_ctx so the model
 * genuinely provides this much context rather than Ollama's small default.
 */
export async function effectiveContextWindow(
	ollamaUrl: string,
	model: string,
	localContextWindow: number
): Promise<number> {
	const arch = await getContextWindow(ollamaUrl, model);
	if (isCloudModel(model)) return arch;
	if (localContextWindow > 0) return Math.min(localContextWindow, arch);
	return arch;
}

/**
 * Request `options` fragment carrying num_ctx for local models, empty for cloud.
 * Spread into a request's `options` so local models actually use the configured
 * window instead of Ollama's small default.
 */
async function localNumCtxOption(
	cfg: LLMCoreConfig,
	ollamaUrl: string,
	model: string
): Promise<Record<string, number>> {
	if (isCloudModel(model)) return {};
	const win = await effectiveContextWindow(ollamaUrl, model, cfg.localContextWindow);
	return { num_ctx: win };
}

// ── Token estimation ──────────────────────────────────────────────────────

/** chars × 0.3 + 4 overhead per message (Odysseus heuristic). */
export function estimateTokens(messages: LLMMessage[]): number {
	return messages.reduce((sum, m) => sum + Math.ceil(m.content.length * 0.3) + 4, 0);
}

// ── Context window discovery ──────────────────────────────────────────────

const KNOWN_WINDOWS: Record<string, number> = {
	'gemma4:e2b': 32768, 'gemma4:e4b': 32768, 'gemma4:12b': 131072,
	'gemma3:1b': 32768, 'gemma3:4b': 8192, 'gemma3:12b': 128000, 'gemma3:27b': 128000,
	'gemma2:9b': 8192, 'gemma2:27b': 8192,
	'qwen3:8b': 32768, 'qwen3:14b': 32768, 'qwen3:32b': 32768,
	'qwen2.5:7b': 32768, 'qwen2.5:14b': 32768,
	'llama3.2:3b': 131072, 'llama3.2:8b': 131072,
	'llama3.1:8b': 131072, 'llama3.1:70b': 131072,
	'mistral:7b': 32768, 'mistral-nemo': 128000,
	'phi4:14b': 16384, 'phi3.5:3.8b': 131072,
	'deepseek-r1:8b': 32768, 'deepseek-r1:14b': 65536,
	'nomic-embed-text': 8192, 'all-minilm': 512, 'all-minilm:l6-v2': 512,
};

const _windows = new Map<string, number>();

export async function getContextWindow(ollamaUrl: string, model: string): Promise<number> {
	const cached = _windows.get(model);
	if (cached) return cached;

	const resolved = await resolveContextWindow(ollamaUrl, model);
	_windows.set(model, resolved);
	return resolved;
}

function parseNumCtx(parameters: string | undefined): number | null {
	// `parameters` is a newline-delimited "key   value" blob; num_ctx, when set
	// via the Modelfile, is the actual runtime window (overrides context_length).
	const m = parameters?.match(/num_ctx\s+(\d+)/);
	return m?.[1] ? parseInt(m[1], 10) : null;
}

async function resolveContextWindow(ollamaUrl: string, model: string): Promise<number> {
	// 1. Authoritative: ask Ollama. This runs FIRST — the static KNOWN_WINDOWS
	//    table is hand-maintained and unreliable (e.g. it listed gemma3:4b as 8192
	//    when /api/show reports 131072), and the prefix heuristic would otherwise
	//    match the smallest "gemma4:*" variant (e2b → 32768) for a 256k model.
	//    Prefer an explicit num_ctx override (the real runtime window) over the
	//    architecture's max context_length.
	try {
		const resp = await requestUrl({
			url: `${ollamaUrl}/api/show`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: model }),
			throw: false,
		});
		if (resp.status === 200) {
			const data = resp.json as { parameters?: string; model_info?: Record<string, unknown> };
			const numCtx = parseNumCtx(data.parameters);
			if (numCtx && numCtx > 0) return numCtx;
			for (const key of Object.keys(data.model_info ?? {})) {
				if (key.includes('context_length') || key.includes('n_ctx')) {
					const v = (data.model_info ?? {})[key];
					if (typeof v === 'number' && v > 0) return v;
				}
			}
		}
	} catch { /* Ollama unreachable — fall back to the static table below */ }

	// 2. Static fallback only when Ollama can't answer: exact, then prefix.
	if (KNOWN_WINDOWS[model]) return KNOWN_WINDOWS[model];
	const base = model.split(':')[0] ?? model;
	const entry = Object.entries(KNOWN_WINDOWS).find(([k]) => k.startsWith(base + ':') || k === base);
	if (entry) return entry[1];

	return 8192;
}

// ── Context-scaled output budgets ──────────────────────────────────────────
// Tool outputs were historically capped at fixed 6k/10k chars — sensible for an
// 8k-window model, but <1% of a 256k window. These budgets scale the caps to the
// model's actual window so large-context models stop needlessly truncating a
// note or search result, while floors preserve the old behaviour on small models.

/** Inverse of estimateTokens' 0.3 tokens/char heuristic (~3.3 chars/token). */
const CHARS_PER_TOKEN = 3.3;

export interface ContextCharBudget {
	/** Max chars a single read_note returns. */
	readNoteChars: number;
	/** Max chars of any one tool output injected back into the conversation. */
	toolResultChars: number;
}

export function contextCharBudget(contextWindow: number): ContextCharBudget {
	const readNoteChars   = Math.max(6_000,  Math.round(contextWindow * 0.25 * CHARS_PER_TOKEN));
	const toolResultChars = Math.max(10_000, Math.round(contextWindow * 0.30 * CHARS_PER_TOKEN));
	return { readNoteChars, toolResultChars };
}

// ── Installed-model resolution ────────────────────────────────────────────
// Configured model names often omit the tag ("all-minilm") while Ollama has
// a tagged variant installed ("all-minilm:l6-v2") — those calls 404. Resolve
// every configured name against /api/tags before use.

const _installed = new Map<string, { names: string[]; fetchedAt: number }>();
const INSTALLED_TTL_MS = 5 * 60 * 1000;

async function installedModels(ollamaUrl: string): Promise<string[]> {
	const cached = _installed.get(ollamaUrl);
	if (cached && Date.now() - cached.fetchedAt < INSTALLED_TTL_MS) return cached.names;
	try {
		const resp = await requestUrl({ url: `${ollamaUrl}/api/tags`, throw: false });
		if (resp.status === 200) {
			const data = resp.json as { models?: { name: string }[] };
			const names = (data.models ?? []).map(m => m.name);
			_installed.set(ollamaUrl, { names, fetchedAt: Date.now() });
			return names;
		}
	} catch { /* Ollama unreachable — fall through */ }
	return cached?.names ?? [];
}

/**
 * Map a configured model name onto an installed one.
 * Exact match wins; then `name:latest`; then any tag sharing the base name.
 * Returns null when the model is definitely not installed, or the name as-is
 * when the installed list could not be fetched.
 */
export async function resolveModel(ollamaUrl: string, model: string): Promise<string | null> {
	const names = await installedModels(ollamaUrl);
	if (names.length === 0) return model; // can't verify — try as-is
	if (names.includes(model)) return model;
	if (names.includes(model + ':latest')) return model + ':latest';
	const base = model.split(':')[0] ?? model;
	return names.find(n => n === base || n.startsWith(base + ':')) ?? null;
}

// ── Capability detection ──────────────────────────────────────────────────

export interface ModelCapabilities {
	structuredOutputs: boolean;
	checkedAt: number;
}

const _caps = new Map<string, ModelCapabilities>();
const CAPS_TTL_MS = 30 * 60 * 1000; // 30 min

export async function detectCapabilities(ollamaUrl: string, model: string): Promise<ModelCapabilities> {
	const cached = _caps.get(model);
	if (cached && Date.now() - cached.checkedAt < CAPS_TTL_MS) return cached;

	let structuredOutputs = false;
	try {
		const resp = await requestUrl({
			url: `${ollamaUrl}/api/chat`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model,
				messages: [{ role: 'user', content: 'Reply with {"ok":true}' }],
				format: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
				stream: false,
				options: { num_predict: 20 },
			}),
			throw: false,
		});
		if (resp.status === 200) {
			const data = resp.json as { message?: { content?: string } };
			const parsed = JSON.parse(data.message?.content ?? '{}') as { ok?: unknown };
			structuredOutputs = parsed.ok === true;
		}
	} catch { /* model rejected the format field */ }

	const caps: ModelCapabilities = { structuredOutputs, checkedAt: Date.now() };
	_caps.set(model, caps);
	return caps;
}

export function getCachedCapabilities(model: string): ModelCapabilities | null {
	return _caps.get(model) ?? null;
}

/** Pre-warm capabilities for all models in a role config. */
export async function warmCapabilities(cfg: LLMCoreConfig): Promise<void> {
	const seen = new Set<string>();
	for (const role of Object.values(cfg.roles)) {
		for (const model of role.models) {
			if (!seen.has(model)) {
				seen.add(model);
				void detectCapabilities(cfg.ollamaUrl, model);
			}
		}
	}
}

// ── Dead-host tracking ────────────────────────────────────────────────────

const _fails = new Map<string, { count: number; lastFail: number }>();
const COOLDOWN_MS = 20_000;
const MAX_FAILS = 2;

function markFail(key: string): void {
	const f = _fails.get(key) ?? { count: 0, lastFail: 0 };
	_fails.set(key, { count: f.count + 1, lastFail: Date.now() });
}

function markOk(key: string): void {
	_fails.delete(key);
}

function inCooldown(key: string): boolean {
	const f = _fails.get(key);
	if (!f || f.count < MAX_FAILS) return false;
	return Date.now() - f.lastFail < COOLDOWN_MS;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function endpoint(cfg: LLMCoreConfig, role: ModelRole): string {
	return cfg.roles[role]?.endpoint ?? cfg.ollamaUrl;
}

function models(cfg: LLMCoreConfig, role: ModelRole): string[] {
	const ms = cfg.roles[role]?.models;
	if (ms && ms.length > 0) return ms;
	return cfg.roles.default?.models ?? ['gemma3:4b'];
}

// ── callStructured ────────────────────────────────────────────────────────

/**
 * Grammar-constrained JSON call. Uses Ollama's `format` field for hard schema
 * enforcement when the model supports it; falls back to a JSON-only prompt on
 * incapable models (same result, slightly weaker guarantee).
 *
 * Always temperature 0 — the model's creativity is irrelevant when outputting
 * a claim confidence score or a dedup decision.
 */
/**
 * Tolerant JSON parse for model output. Thinking models (e.g. gemma4:31b) and
 * many cloud models wrap structured output in ```json fences or emit a
 * <think>…</think> block first, so a bare JSON.parse fails. We strip those, then
 * parse; failing that, we grab the first balanced {...} / [...] span.
 */
export function coerceJSON<T>(raw: string): T {
	let s = raw.trim();
	s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();   // drop reasoning block
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);    // unwrap code fence
	if (fence?.[1]) s = fence[1].trim();

	try {
		return JSON.parse(s) as T;
	} catch { /* fall through to span extraction */ }

	const start = ((): number => {
		const o = s.indexOf('{'), a = s.indexOf('[');
		if (o === -1) return a;
		if (a === -1) return o;
		return Math.min(o, a);
	})();
	if (start !== -1) {
		const close = s[start] === '{' ? '}' : ']';
		const end = s.lastIndexOf(close);
		if (end > start) return JSON.parse(s.slice(start, end + 1)) as T;
	}
	throw new Error('No JSON found in model output');
}

export async function callStructured<T>(
	cfg: LLMCoreConfig,
	role: ModelRole,
	schema: Record<string, unknown>,
	messages: LLMMessage[],
	opts: LLMOptions = {}
): Promise<T> {
	const ep = endpoint(cfg, role);
	let lastErr: Error = new Error('No models configured for role: ' + role);

	for (const configured of models(cfg, role)) {
		const model = await resolveModel(ep, configured);
		if (!model) { lastErr = new Error(`Model not installed: ${configured}`); continue; }
		const key = `${ep}:${model}`;
		if (inCooldown(key)) continue;

		const caps = getCachedCapabilities(model);
		// Optimistically use format: true until proven otherwise
		const useFormat = caps ? caps.structuredOutputs : true;

		// Local models honor only the num_ctx we send; cloud models manage their own.
		const ctxOpt = await localNumCtxOption(cfg, ep, model);

		// think:false — structured output is consumed by code, not read; the
		// thinking phase only adds latency and (for gemma4-class models) makes the
		// forced JSON diverge from the reasoning. See Ollama issue #15386.
		let body: Record<string, unknown>;
		if (useFormat) {
			body = {
				model,
				messages,
				format: schema,
				stream: false,
				think: false,
				options: { temperature: 0, ...ctxOpt, ...opts },
			};
		} else {
			// Fallback: put the schema in the prompt (no format field — thinking
			// models ignore/garble it) and tolerate fenced JSON when parsing.
			const msgs = [...messages];
			const last = msgs[msgs.length - 1];
			if (last?.role === 'user') {
				msgs[msgs.length - 1] = {
					...last,
					content: last.content + '\n\nRespond ONLY with valid JSON matching this schema: ' + JSON.stringify(schema),
				};
			}
			body = { model, messages: msgs, stream: false, think: false, options: { temperature: 0, ...ctxOpt, ...opts } };
		}

		try {
			const resp = await requestUrl({
				url: `${ep}/api/chat`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				throw: false,
			});

			if (resp.status === 0) throw new Error('Cannot reach Ollama. Is it running? (`ollama serve`)');
			if (resp.status >= 400) throw new Error(`Ollama error HTTP ${resp.status}`);

			const data = resp.json as { message?: { content?: string } };
			const raw = (data.message?.content ?? '').trim();
			markOk(key);

			try {
				return coerceJSON<T>(raw);
			} catch {
				// Parse failed even after fence/think tolerance — if we used format
				// mode this model probably doesn't support it; flip to the prompt
				// path so the next call (and retries) use schema-in-prompt instead.
				if (useFormat) {
					_caps.set(model, { structuredOutputs: false, checkedAt: Date.now() });
				}
				throw new Error(`Model returned invalid JSON: ${raw.slice(0, 300)}`);
			}
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			// Only count as dead-host if error was pre-content (connection/HTTP error, not bad JSON)
			if (!lastErr.message.includes('invalid JSON')) markFail(key);
		}
	}

	throw lastErr;
}

// ── callStreaming ──────────────────────────────────────────────────────────

/**
 * Streaming prose call. Fires `onToken` for each text chunk, `onDone` when
 * the stream closes. For chat, /write, synthesis — anything a human will read.
 *
 * Tries each model in the role's fallback chain. Once a model emits at least
 * one token, it is locked onto (Odysseus §3.4: don't switch mid-output).
 */
export async function callStreaming(
	cfg: LLMCoreConfig,
	role: ModelRole,
	messages: LLMMessage[],
	opts: LLMOptions,
	onToken: (token: string) => void,
	onDone?: () => void
): Promise<void> {
	const ep = endpoint(cfg, role);
	let lastErr: Error = new Error('No models configured for role: ' + role);

	for (const configured of models(cfg, role)) {
		const model = await resolveModel(ep, configured);
		if (!model) { lastErr = new Error(`Model not installed: ${configured}`); continue; }
		const key = `${ep}:${model}`;
		if (inCooldown(key)) continue;

		// Local models honor only the num_ctx we send; cloud models manage their own.
		const ctxOpt = await localNumCtxOption(cfg, ep, model);

		try {
			// eslint-disable-next-line no-restricted-globals
			const response = await fetch(`${ep}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					messages,
					stream: true,
					options: { temperature: 0.7, ...ctxOpt, ...opts },
				}),
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			if (!response.body) throw new Error('No response body');

			markOk(key);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let emitted = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				for (const line of chunk.split('\n')) {
					if (!line.trim()) continue;
					try {
						const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
						const token = parsed.message?.content ?? '';
						if (token) { emitted = true; onToken(token); }
					} catch { /* partial JSON line, skip */ }
				}
			}

			// If we emitted at least one token, don't try fallbacks
			if (emitted) { onDone?.(); return; }

			// Zero tokens from this model — treat as failure and try next
			markFail(key);
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			markFail(key);
		}
	}

	throw lastErr;
}

/** Collect all streaming tokens into a single string. */
export async function callStreamingCollect(
	cfg: LLMCoreConfig,
	role: ModelRole,
	messages: LLMMessage[],
	opts: LLMOptions = {}
): Promise<string> {
	let out = '';
	await callStreaming(cfg, role, messages, opts, t => { out += t; });
	return out;
}

// ── Embeddings ────────────────────────────────────────────────────────────

export interface EmbeddingResult {
	vector: number[];
	model: string;
}

// Embeddings get a few quick retries before a failure counts toward the
// dead-host cooldown. On a synced vault, file-sync bursts fire many concurrent
// embed calls and the embedding model may need a moment to load — a single
// transient blip should not trip the 20s cooldown and cascade an entire reindex.
const EMBED_ATTEMPTS   = 3;
const EMBED_BACKOFF_MS  = 400;

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get a text embedding from the embedding-role model. */
export async function getEmbedding(
	cfg: LLMCoreConfig,
	text: string
): Promise<EmbeddingResult> {
	const ep = endpoint(cfg, 'embedding');
	const ms = models(cfg, 'embedding');
	let lastErr: Error | null = null;

	for (const configured of ms) {
		const model = await resolveModel(ep, configured);
		if (!model) {
			lastErr = new Error(`Embedding model not installed: ${configured} (run \`ollama pull ${configured}\`)`);
			continue;
		}
		const key = `${ep}:${model}`;
		if (inCooldown(key)) {
			lastErr = new Error(`Embedding model "${model}" is cooling down after repeated failures`);
			continue;
		}

		// Retry transient failures before marking the host dead.
		for (let attempt = 0; attempt < EMBED_ATTEMPTS; attempt++) {
			try {
				const resp = await requestUrl({
					url: `${ep}/api/embeddings`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model, prompt: text }),
					throw: false,
				});
				if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
				const data = resp.json as { embedding?: number[] };
				if (!data.embedding?.length) throw new Error('Empty embedding response');
				markOk(key);
				return { vector: data.embedding, model };
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err));
				if (attempt < EMBED_ATTEMPTS - 1) {
					await sleep(EMBED_BACKOFF_MS * (attempt + 1)); // 400ms, 800ms
				} else {
					markFail(key); // only count a hard failure after all retries
				}
			}
		}
	}
	throw lastErr ?? new Error('No embedding models available');
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] ?? 0) * (b[i] ?? 0);
		na  += (a[i] ?? 0) ** 2;
		nb  += (b[i] ?? 0) ** 2;
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
