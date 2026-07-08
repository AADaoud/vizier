import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { registerServerEnsurer, ensureVizierServer, probeServer } from '../src/server_lifecycle';

// v0.7-only: the Vizier server can now be auto-started on demand. Commands and
// agent tools call ensureVizierServer() instead of failing with "server not
// running"; the plugin registers the real ensurer (TranscriptServerManager) on
// load, and without one the module falls back to a plain reachability probe.

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;
function resp(status: number) {
	return { status, json: {}, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
}

beforeEach(() => mockRequest.mockReset());
afterEach(() => registerServerEnsurer(null));

describe('probeServer()', () => {
	it('returns true when /health answers (any status > 0)', async () => {
		mockRequest.mockResolvedValueOnce(resp(200));
		expect(await probeServer('http://localhost:11435')).toBe(true);
	});

	it('returns false on status 0 (connection refused)', async () => {
		mockRequest.mockResolvedValueOnce(resp(0));
		expect(await probeServer('http://localhost:11435')).toBe(false);
	});

	it('returns false when the request throws', async () => {
		mockRequest.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		expect(await probeServer('http://localhost:11435')).toBe(false);
	});
});

describe('ensureVizierServer()', () => {
	it('falls back to a reachability probe when no ensurer is registered', async () => {
		mockRequest.mockResolvedValueOnce(resp(200));
		expect(await ensureVizierServer('http://localhost:11435')).toBe('ok');

		mockRequest.mockResolvedValueOnce(resp(0));
		expect(await ensureVizierServer('http://localhost:11435')).toBe('offline');
	});

	it('delegates to the registered ensurer (the plugin-owned server manager)', async () => {
		const seen: string[] = [];
		registerServerEnsurer(async (url) => { seen.push(url); return 'started'; });
		expect(await ensureVizierServer('http://localhost:11435')).toBe('started');
		expect(seen).toEqual(['http://localhost:11435']);
	});
});
