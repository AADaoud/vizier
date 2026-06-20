import { describe, it, expect, beforeEach } from 'vitest';
import { callOllama, callOllamaStructured } from '../src/utils/ollama';
import { requestUrl } from 'obsidian';

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;

function resp(status: number, json: unknown) {
	return { status, json, text: JSON.stringify(json), arrayBuffer: new ArrayBuffer(0), headers: {} };
}

beforeEach(() => mockRequest.mockReset());

describe('callOllama()', () => {
	it('posts to /api/chat with stream disabled and returns message content', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, { message: { content: 'hello world' } }));

		const out = await callOllama({
			ollamaUrl: 'http://localhost:11434',
			model: 'gemma3:4b',
			messages: [{ role: 'user', content: 'hi' }],
		});

		expect(out).toBe('hello world');
		const arg = mockRequest.mock.calls[0][0] as { url: string; method: string; body: string };
		expect(arg.url).toBe('http://localhost:11434/api/chat');
		expect(arg.method).toBe('POST');
		const body = JSON.parse(arg.body) as { stream: boolean; model: string; ollamaUrl?: string };
		expect(body.stream).toBe(false);
		expect(body.model).toBe('gemma3:4b');
		// ollamaUrl must NOT leak into the request body
		expect(body.ollamaUrl).toBeUndefined();
	});

	it('returns empty string when the response has no content', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, {}));
		expect(await callOllama({ ollamaUrl: 'u', model: 'm', messages: [] })).toBe('');
	});

	it('throws a "cannot reach Ollama" error on status 0', async () => {
		mockRequest.mockResolvedValueOnce(resp(0, {}));
		await expect(callOllama({ ollamaUrl: 'u', model: 'm', messages: [] }))
			.rejects.toThrow(/Cannot reach Ollama/);
	});

	it('throws on HTTP >= 400', async () => {
		mockRequest.mockResolvedValueOnce(resp(500, {}));
		await expect(callOllama({ ollamaUrl: 'u', model: 'm', messages: [] }))
			.rejects.toThrow(/HTTP 500/);
	});
});

describe('callOllamaStructured()', () => {
	it('parses JSON content into a typed object', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, { message: { content: '{"title":"T","score":3}' } }));
		const out = await callOllamaStructured<{ title: string; score: number }>({
			ollamaUrl: 'u', model: 'm', messages: [],
		});
		expect(out).toEqual({ title: 'T', score: 3 });
	});

	it('throws a descriptive error on invalid JSON', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, { message: { content: 'not json' } }));
		await expect(callOllamaStructured({ ollamaUrl: 'u', model: 'm', messages: [] }))
			.rejects.toThrow(/invalid JSON/);
	});
});
