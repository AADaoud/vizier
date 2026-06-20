import { describe, it, expect, beforeEach } from 'vitest';
import { contextCharBudget, getContextWindow } from '../src/llm_core';
import { requestUrl } from 'obsidian';

// v0.7-only: llm_core has no v0.6.5 equivalent. Guards the window-detection fix
// and the context-scaled output budgets.

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;

function showResp(modelInfo: Record<string, unknown>) {
	return { status: 200, json: { model_info: modelInfo }, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
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
	it('returns an exact known window without hitting the network', async () => {
		expect(await getContextWindow('http://x', 'gemma3:4b')).toBe(8192);
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('uses Ollama /api/show BEFORE the prefix heuristic (the 31b-cloud fix)', async () => {
		// Prefix match alone would wrongly resolve gemma4:* → gemma4:e2b (32768).
		mockRequest.mockResolvedValueOnce(showResp({ 'gemma4.context_length': 262144 }));
		expect(await getContextWindow('http://x', 'gemma4:31b-cloud')).toBe(262144);
	});

	it('falls back to the prefix heuristic when /api/show has no context length', async () => {
		mockRequest.mockResolvedValueOnce(showResp({}));
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
