import { describe, it, expect, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import { executeTool } from '../src/agent/tool_execution';
import { DEFAULT_SETTINGS, type AIAgentSettings } from '../src/settings';
import { createFakeApp } from './mocks/fakeVault';

// v0.7-only: the agent's create_entity tool must
//   1. never create a duplicate note when the entity already exists (the
//      common cause is the model retrying a create that already succeeded),
//   2. report real failures as ERROR results (ok=false) with explicit
//      do-not-retry guidance — previously "Vizier server is not running"
//      came back as a SUCCESS tool result and the model retried forever,
//   3. never open modals: with no Wikipedia results it fails fast instead of
//      prompting the user mid-agent-run.

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;
function resp(status: number, json: unknown = {}) {
	return { status, json, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
}

function settings(): AIAgentSettings {
	return { ...DEFAULT_SETTINGS, roles: DEFAULT_SETTINGS.roles, features: { ...DEFAULT_SETTINGS.features } };
}

beforeEach(() => mockRequest.mockReset());

describe('create_entity tool', () => {
	it('refuses to create a duplicate when the entity note already exists', async () => {
		const app = createFakeApp([{ path: 'Human Network/People/Henry Kissinger.md' }]) as unknown as App;
		const result = await executeTool(
			{ name: 'create_entity', params: { type: 'person', name: 'Henry Kissinger' } },
			app, settings()
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain('already exists');
		// Points the model at productive next steps instead of a retry
		expect(result.output).toMatch(/link_entities|read_note/);
	});

	it('returns an ERROR (ok=false) with do-not-retry guidance when the server is offline', async () => {
		// /health probe → connection refused; no ensurer registered in tests
		mockRequest.mockResolvedValue(resp(0));
		const app = createFakeApp([]) as unknown as App;
		const result = await executeTool(
			{ name: 'create_entity', params: { type: 'person', name: 'Zhou Enlai' } },
			app, settings()
		);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(/^ERROR:/);
		expect(result.output).toContain('Do NOT retry');
	});

	it('fails fast (no modal) when Wikipedia has no results in the non-interactive agent path', async () => {
		// health probe ok → wiki probe ok → search returns empty results
		mockRequest.mockImplementation((opts: { url: string }) => {
			const url = opts?.url ?? '';
			if (url.includes('/health')) return Promise.resolve(resp(200));
			if (url.includes('/wiki/search')) return Promise.resolve(resp(200, { results: [] }));
			return Promise.resolve(resp(200));
		});
		const app = createFakeApp([]) as unknown as App;
		const result = await executeTool(
			{ name: 'create_entity', params: { type: 'person', name: 'Nonexistent Person Xyz' } },
			app, settings()
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain('No Wikipedia results');
		expect(result.output).toContain('write_note');
	});
});
