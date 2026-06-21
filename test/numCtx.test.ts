import { describe, it, expect, beforeEach } from 'vitest';
import { callStructured, type LLMCoreConfig } from '../src/llm_core';
import { requestUrl } from 'obsidian';

// v0.7-only: verifies num_ctx is sent for LOCAL models (so they actually use the
// configured window) but never for cloud models (the provider manages context).

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;

let urlSeq = 0;
function cfg(model: string): LLMCoreConfig {
	return {
		ollamaUrl: `http://ctx-${urlSeq++}`,
		roles: {
			default:   { models: [model] },
			utility:   { models: [model] },
			research:  { models: [model] },
			embedding: { models: ['all-minilm:l6-v2'] },
		},
		localContextWindow: 8192,
	};
}

function resp(status: number, json: unknown) {
	return { status, json, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
}

// Route /api/tags (model resolution), /api/show (window), /api/chat (the call).
function route(model: string, contextLength: number) {
	mockRequest.mockImplementation(async (opts?: { url?: string }) => {
		const url = opts?.url ?? '';
		if (url.endsWith('/api/tags')) return resp(200, { models: [{ name: model }] });
		if (url.endsWith('/api/show')) return resp(200, { model_info: { 'm.context_length': contextLength } });
		if (url.endsWith('/api/chat')) return resp(200, { message: { content: '{"ok":true}' } });
		return resp(200, {});
	});
}

function chatBody(): { options?: { num_ctx?: number } } {
	const call = mockRequest.mock.calls.find(c => (c[0] as { url?: string }).url?.endsWith('/api/chat'));
	return JSON.parse((call?.[0] as { body: string }).body) as { options?: { num_ctx?: number } };
}

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

beforeEach(() => mockRequest.mockReset());

describe('callStructured num_ctx handling', () => {
	it('sends num_ctx clamped to the local window for a local model', async () => {
		route('gemma3:4b', 131072);
		await callStructured(cfg('gemma3:4b'), 'default', schema, [{ role: 'user', content: 'hi' }]);
		expect(chatBody().options?.num_ctx).toBe(8192); // min(8192, 131072)
	});

	it('does NOT send num_ctx for a cloud model', async () => {
		route('gemma4:31b-cloud', 262144);
		await callStructured(cfg('gemma4:31b-cloud'), 'default', schema, [{ role: 'user', content: 'hi' }]);
		expect(chatBody().options?.num_ctx).toBeUndefined();
	});
});
