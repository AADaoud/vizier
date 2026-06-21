import { describe, it, expect, beforeEach } from 'vitest';
import { contextCharBudget, getContextWindow, isCloudModel, effectiveContextWindow } from '../src/llm_core';
import { requestUrl } from 'obsidian';

// v0.7-only: llm_core has no v0.6.5 equivalent. Guards the window-detection fix
// and the context-scaled output budgets.

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;

function showResp(modelInfo: Record<string, unknown>, parameters?: string) {
	return { status: 200, json: { model_info: modelInfo, parameters }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
}

beforeEach(() => mockRequest.mockReset());

describe('contextCharBudget()', () => {
	it('honours the historical floors on small windows', () => {
		const b = contextCharBudget(8192);
		expect(b.readNoteChars).toBeGreaterThanOrEqual(6_000);
		expect(b.toolResultChars).toBe(10_000); // 8k window still floors here
	});

	it('floors hold for tiny/zero windows', () => {
		const b = contextCharBudget(1000);
		expect(b.readNoteChars).toBe(6_000);
		expect(b.toolResultChars).toBe(10_000);
	});

	it('scales up for a 256k window instead of staying at 6k/10k', () => {
		const b = contextCharBudget(262144);
		expect(b.readNoteChars).toBeGreaterThan(200_000);
		expect(b.toolResultChars).toBeGreaterThan(250_000);
	});

	it('keeps readNoteChars <= toolResultChars so read_note output is not double-truncated', () => {
		for (const w of [8192, 32768, 131072, 262144]) {
			const b = contextCharBudget(w);
			expect(b.readNoteChars).toBeLessThanOrEqual(b.toolResultChars);
		}
	});

	it('is monotonic in the window size', () => {
		const small = contextCharBudget(8192);
		const big = contextCharBudget(262144);
		expect(big.readNoteChars).toBeGreaterThan(small.readNoteChars);
		expect(big.toolResultChars).toBeGreaterThan(small.toolResultChars);
	});
});

describe('getContextWindow()', () => {
	it('trusts /api/show context_length over the static table (the 31b-cloud fix)', async () => {
		// The table/prefix heuristic would wrongly give gemma4:* → 32768.
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma4.context_length': 262144 }));
		expect(await getContextWindow('http://x', 'gemma4:31b-cloud')).toBe(262144);
	});

	it('trusts /api/show even for a model whose table entry is stale', async () => {
		// KNOWN_WINDOWS lists gemma3:4b as 8192, but Ollama reports 131072.
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma3.context_length': 131072 }));
		expect(await getContextWindow('http://x', 'gemma3:4b')).toBe(131072);
	});

	it('prefers an explicit num_ctx override over context_length', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma3.context_length': 131072 }, 'temperature 0.7\nnum_ctx 8192'));
		expect(await getContextWindow('http://x', 'gemma3:4b-capped')).toBe(8192);
	});

	it('falls back to the static table when Ollama is unreachable', async () => {
		mockRequest.mockResolvedValueOnce({ status: 0, json: {}, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} });
		// base "gemma3" → first gemma3:* entry (gemma3:1b = 32768)
		expect(await getContextWindow('http://x', 'gemma3:99b-unknown')).toBe(32768);
	});

	it('defaults to 8192 when nothing resolves', async () => {
		mockRequest.mockResolvedValueOnce({ status: 0, json: {}, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} });
		expect(await getContextWindow('http://x', 'totally-unknown-model')).toBe(8192);
	});

	it('caches the result (no second network call for the same model)', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'foo.context_length': 12345 }));
		const first = await getContextWindow('http://x', 'cache-probe-model');
		const second = await getContextWindow('http://x', 'cache-probe-model');
		expect(first).toBe(12345);
		expect(second).toBe(12345);
		expect(mockRequest).toHaveBeenCalledTimes(1);
	});
});

describe('isCloudModel()', () => {
	it('detects cloud models by the :cloud / -cloud suffix', () => {
		expect(isCloudModel('gemma4:31b-cloud')).toBe(true);
		expect(isCloudModel('minimax-m3:cloud')).toBe(true);
		expect(isCloudModel('GPT-OSS:120B-CLOUD')).toBe(true); // case-insensitive
	});

	it('treats normal local models as not cloud', () => {
		expect(isCloudModel('gemma3:4b')).toBe(false);
		expect(isCloudModel('all-minilm:l6-v2')).toBe(false);
		expect(isCloudModel('llama3.2')).toBe(false);
	});
});

describe('effectiveContextWindow()', () => {
	it('cloud models use their full architectural window (ignore local setting)', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma4.context_length': 262144 }));
		expect(await effectiveContextWindow('http://x', 'gemma4:31b-cloud', 8192)).toBe(262144);
	});

	it('local models are clamped to the configured local window', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma3.context_length': 131072 }));
		expect(await effectiveContextWindow('http://x', 'gemma3:4b', 8192)).toBe(8192);
	});

	it('local setting never exceeds the model max', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'tiny.context_length': 4096 }));
		expect(await effectiveContextWindow('http://x', 'tiny:1b', 32768)).toBe(4096);
	});

	it('local setting of 0 means use the model max', async () => {
		mockRequest.mockResolvedValueOnce(showResp({ 'big.context_length': 131072 }));
		expect(await effectiveContextWindow('http://x', 'big:7b', 0)).toBe(131072);
	});
});
