/**
 * Startup capability probing: only chat models are probed, never the
 * embedding or vision models, and one at a time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { warmCapabilities, callStructured, type LLMCoreConfig } from '../src/llm_core';
import { requestUrl } from 'obsidian';

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;
const OK = (json: unknown) => ({ status: 200, json, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} });

let urlSeq = 0;
function cfg(roles: Partial<Record<string, string[]>> = {}): LLMCoreConfig {
	const r = { default: ['chat-a'], utility: ['chat-b'], research: ['chat-a'], embedding: ['embed-x'], vision: ['vision-y'], ...roles };
	return {
		ollamaUrl: `http://warm-${urlSeq++}`,
		roles: Object.fromEntries(Object.entries(r).map(([k, models]) => [k, { models }])) as LLMCoreConfig['roles'],
		localContextWindow: 8192,
	};
}

beforeEach(() => mockRequest.mockReset());

describe('warmCapabilities', () => {
	it('probes each chat model once and never the embedding or vision model', async () => {
		const probed: string[] = [];
		mockRequest.mockImplementation(async (opts?: { url?: string; body?: string }) => {
			if ((opts?.url ?? '').endsWith('/api/chat')) probed.push((JSON.parse(opts?.body ?? '{}') as { model: string }).model);
			return OK({ message: { content: '{"ok":true}' } });
		});
		await warmCapabilities(cfg({ default: ['warm-a'], utility: ['warm-b'], research: ['warm-a'], embedding: ['warm-embed'], vision: ['warm-vision'] }));
		expect(probed.sort()).toEqual(['warm-a', 'warm-b']);
	});

	it('probes one model at a time', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		mockRequest.mockImplementation(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise(r => setTimeout(r, 5));
			inFlight--;
			return OK({ message: { content: '{"ok":true}' } });
		});
		await warmCapabilities(cfg({ default: ['seq-a'], utility: ['seq-b'], research: ['seq-c'] }));
		expect(maxInFlight).toBe(1);
	});
});

describe('model cool-down', () => {
	it('names the cool-down instead of "No models configured" when the only model is cooling down', async () => {
		const c = cfg({ default: ['cool-a'] });
		mockRequest.mockImplementation(async (opts?: { url?: string }) => {
			if ((opts?.url ?? '').endsWith('/api/tags')) return OK({ models: [{ name: 'cool-a' }] });
			return { status: 500, json: {}, text: 'boom', arrayBuffer: new ArrayBuffer(0), headers: {} };
		});
		const call = () => callStructured(c, 'default', {}, [{ role: 'user', content: 'x' }]);
		// Fail until the model enters its cool-down, then check the message.
		let last = '';
		for (let i = 0; i < 4; i++) last = await call().then(() => '', (e: Error) => e.message);
		expect(last).toMatch(/cooling down/i);
		expect(last).not.toMatch(/No models configured/);
	});
});
