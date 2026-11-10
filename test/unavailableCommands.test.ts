/**
 * Features with no server side yet say so up front instead of failing after a
 * request to a route that does not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import { executeIngest, executeTranscribe } from '../src/commands/ingestCommands';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;
const cfg = { ollamaUrl: 'http://localhost:11434', serverUrl: 'http://127.0.0.1:11435' } as never;

async function run(fn: typeof executeIngest, args: string): Promise<string[]> {
	const out: string[] = [];
	const app = createFakeApp([]) as unknown as App;
	await fn(args, app, (_r, c) => { out.push(c); }, (_r, c) => { out[out.length - 1] = c; }, 'm', cfg, DEFAULT_SETTINGS);
	return out;
}

beforeEach(() => { mockRequest.mockClear(); });

describe('/transcribe', () => {
	it('says audio transcription is not available and calls no server', async () => {
		const out = await run(executeTranscribe, 'Audio/talk.mp3');
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/not available/i);
		expect(mockRequest).not.toHaveBeenCalled();
	});
});

describe('/ingest', () => {
	it.each(['Books/book.pdf', 'Books/BOOK.PDF'])('says PDF ingestion is not available for %s and calls no server', async (p) => {
		const out = await run(executeIngest, p);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/PDF.*not available/i);
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('still shows usage when no path is given', async () => {
		expect((await run(executeIngest, ''))[0]).toMatch(/Usage/);
	});
});
