import { describe, it, expect, beforeEach } from 'vitest';
import { getEmbedding, type LLMCoreConfig } from '../src/llm_core';
import { requestUrl } from 'obsidian';

// v0.7-only: llm_core. Covers the embedding retry that stops transient
// sync-burst failures from tripping the dead-host cooldown.

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;

// Unique endpoint per test so the installed-model cache (keyed by URL) misses.
let urlSeq = 0;
function cfg(): LLMCoreConfig {
	return {
		ollamaUrl: `http://emb-${urlSeq++}`,
		roles: {
			default:   { models: ['m'] },
			utility:   { models: ['m'] },
			research:  { models: ['m'] },
			embedding: { models: ['all-minilm:l6-v2'] },
		},
	};
}

const TAGS = { status: 200, json: { models: [{ name: 'all-minilm:l6-v2' }] }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
const EMB_OK = { status: 200, json: { embedding: [0.1, 0.2, 0.3] }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
const EMB_500 = { status: 500, json: {}, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };

function route(embeddingResponses: unknown[]) {
	let i = 0;
	mockRequest.mockImplementation(async (opts?: { url?: string }) => {
		const url = opts?.url ?? '';
		if (url.endsWith('/api/tags')) return TAGS;
		if (url.endsWith('/api/embeddings')) return embeddingResponses[i++] ?? EMB_OK;
		return { status: 200, json: {}, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
	});
}

beforeEach(() => mockRequest.mockReset());

describe('getEmbedding() retry', () => {
	it('returns the vector on first success', async () => {
		route([EMB_OK]);
		const r = await getEmbedding(cfg(), 'hello');
		expect(r.vector).toEqual([0.1, 0.2, 0.3]);
		expect(r.model).toBe('all-minilm:l6-v2');
	});

	it('retries a transient failure and then succeeds', async () => {
		route([EMB_500, EMB_OK]); // first attempt 500, second OK
		const r = await getEmbedding(cfg(), 'hello');
		expect(r.vector.length).toBe(3);
		// two embedding attempts were made (plus the tags lookup)
		const embedCalls = mockRequest.mock.calls.filter(c => (c[0] as { url: string }).url.endsWith('/api/embeddings'));
		expect(embedCalls.length).toBe(2);
	});

	it('throws after all attempts fail', async () => {
		route([EMB_500, EMB_500, EMB_500]);
		await expect(getEmbedding(cfg(), 'hello')).rejects.toThrow(/HTTP 500/);
		const embedCalls = mockRequest.mock.calls.filter(c => (c[0] as { url: string }).url.endsWith('/api/embeddings'));
		expect(embedCalls.length).toBe(3); // EMBED_ATTEMPTS
	});

	it('treats an empty embedding response as a failure', async () => {
		const EMPTY = { status: 200, json: { embedding: [] }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
		route([EMPTY, EMB_OK]);
		const r = await getEmbedding(cfg(), 'hello');
		expect(r.vector.length).toBe(3); // recovered on retry
	});
}, 15_000);
