/**
 * One request must change the vault once: repeated vault-changing tool calls
 * are skipped within a run, write_note never writes a second copy of a note,
 * and the verifier judges this turn only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';

// Scripted responses for every callStructured call, in order
// (tool decisions, verifier verdicts, verifier fix calls).
const llm = vi.hoisted(() => ({
	script: [] as unknown[],
	structured: [] as Array<{ role: string; prompt: string }>,
	onStructured: (): void => {},
}));

vi.mock('../src/llm_core', async (orig) => {
	const real = await orig<typeof import('../src/llm_core')>();
	return {
		...real,
		effectiveContextWindow: vi.fn(async () => 8192),
		callStructured: vi.fn(async (_c: unknown, role: string, _s: unknown, messages: Array<{ content: string }>) => {
			llm.structured.push({ role, prompt: messages.map(m => m.content).join('\n') });
			llm.onStructured();
			return llm.script.shift() ?? { calls: [], done: true };
		}),
		callStreaming: vi.fn(async (_c: unknown, _r: unknown, _m: unknown, _o: unknown, onToken: (t: string) => void) => { onToken('ok'); }),
	};
});
vi.mock('../src/agent/prompt_builder', () => ({
	buildSystemPrompt: async () => [{ role: 'system', content: 'sys' }],
	invalidateVaultCache: () => {},
}));
vi.mock('../src/skills/skills', () => ({
	loadSkills: async () => [], selectSkills: () => [], formatSkillsBlock: () => '', distillSkill: async () => null,
}));
vi.mock('../src/ui/activity', () => ({ beginActivity: () => {}, endActivity: () => {}, updateActivity: () => {} }));

import { runAgentLoop, type AgentEvent } from '../src/agent/loop';
import { executeTool } from '../src/agent/tool_execution';
import type { ToolCall } from '../src/schemas/index';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

function vaultThatRecordsCreates(existing: string[] = []): { app: App; created: string[] } {
	const fake = createFakeApp([]) as unknown as Record<string, Record<string, unknown>>;
	const created: string[] = [];
	const paths = new Set<string>(existing);
	fake.vault!.getAbstractFileByPath = (p: string) => (paths.has(p) ? { path: p } : null);
	fake.vault!.createFolder = async (p: string) => { paths.add(p); };
	fake.vault!.create = async (p: string) => { paths.add(p); created.push(p); };
	return { app: fake as unknown as App, created };
}

const write = (filename = 'Plan', content = 'body') => ({ name: 'write_note', params: { filename, content, folder: 'AI' } });
const WRITE = write();
const SUCCESS = { result: 'SUCCESS', issues: [] };
const RETRY = { result: 'RETRY', issues: ['note content missing'] };

interface RunOpts {
	history?: Array<{ role: 'user' | 'assistant'; content: string }>;
	signal?: AbortSignal;
}
async function run(steps: unknown[], opts: RunOpts = {}): Promise<{ created: string[]; events: AgentEvent[] }> {
	const { app, created } = vaultThatRecordsCreates();
	llm.script.length = 0;
	llm.script.push(...steps);
	const events: AgentEvent[] = [];
	await runAgentLoop('write a plan note', opts.history ?? [], app, DEFAULT_SETTINGS, e => { events.push(e); }, [], opts.signal);
	return { created, events };
}
const results = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');

beforeEach(() => {
	llm.structured.length = 0;
	llm.onStructured = () => {};
});

describe('one request writes one file', () => {
	it('same write_note twice in one round', async () => {
		const { created, events } = await run([{ calls: [WRITE, WRITE], done: true }, SUCCESS]);
		expect(created).toEqual(['AI/Plan.md']);
		// The repeat is reported to the user as skipped, not as a failure.
		expect(results(events).map(r => r.ok)).toEqual([true, true]);
		expect(results(events)[1]?.output).toMatch(/already ran/i);
	});

	it('write repeated two rounds later', async () => {
		const { created } = await run([
			{ calls: [WRITE], done: false },
			{ calls: [{ name: 'vault_search', params: { query: 'plan' } }], done: false },
			{ calls: [WRITE], done: true },
			SUCCESS,
		]);
		expect(created).toEqual(['AI/Plan.md']);
	});

	it('verifier RETRY does not re-run a write that already succeeded', async () => {
		const { created } = await run([{ calls: [WRITE], done: true }, RETRY, { calls: [WRITE], done: true }]);
		expect(created).toEqual(['AI/Plan.md']);
	});

	it('a different note in the same run is still written', async () => {
		const { created } = await run([{ calls: [WRITE, write('Budget')], done: true }, SUCCESS]);
		expect(created).toEqual(['AI/Plan.md', 'AI/Budget.md']);
	});

	it('a failed write may be retried with the same params', async () => {
		const { app, created } = vaultThatRecordsCreates();
		let attempts = 0;
		const vault = (app as unknown as { vault: { create: (p: string) => Promise<void> } }).vault;
		const create = vault.create;
		vault.create = async (p: string) => {
			if (++attempts === 1) throw new Error('disk busy');
			return create(p);
		};
		llm.script.length = 0;
		llm.script.push(
			{ calls: [WRITE], done: false },
			{ calls: [{ name: 'vault_search', params: { query: 'plan' } }], done: false },
			{ calls: [WRITE], done: true },
			SUCCESS,
		);
		await runAgentLoop('write a plan note', [], app, DEFAULT_SETTINGS, () => {});
		expect(created).toEqual(['AI/Plan.md']);
		expect(attempts).toBe(2);
	});
});

describe('write_note', () => {
	const call = (c: unknown) => c as unknown as ToolCall;

	it('refuses to write a second copy of an existing note and points to it', async () => {
		const { app, created } = vaultThatRecordsCreates(['AI/Plan.md']);
		const r = await executeTool(call(WRITE), app, DEFAULT_SETTINGS);
		expect(created).toEqual([]);
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/^ERROR:/);
		expect(r.output).toContain('[[Plan]]');
		expect(r.output).toContain('edit_note');
	});

	it('reports a failed create as a failure', async () => {
		const { app } = vaultThatRecordsCreates();
		(app as unknown as { vault: { create: () => Promise<void> } }).vault.create = async () => { throw new Error('disk full'); };
		const r = await executeTool(call(WRITE), app, DEFAULT_SETTINGS);
		expect(r.ok).toBe(false);
		expect(r.output).toMatch(/^ERROR:.*disk full/);
	});
});

describe('verifier', () => {
	const verifierPrompt = () => llm.structured.find(c => c.role === 'utility')?.prompt ?? '';

	it('judges this turn only, not earlier chat history', async () => {
		const history = [
			{ role: 'user' as const, content: 'OLD-TURN-MARKER ' + 'x'.repeat(9000) },
			{ role: 'assistant' as const, content: 'old reply' },
		];
		await run([{ calls: [WRITE], done: true }, SUCCESS], { history });
		expect(verifierPrompt()).not.toContain('OLD-TURN-MARKER');
		expect(verifierPrompt()).toContain('Created [[Plan]]');
	});

	it('keeps the latest tool results when the turn is long', async () => {
		await run([
			{ calls: [write('Filler', 'y'.repeat(9000))], done: false },
			{ calls: [WRITE], done: true },
			SUCCESS,
		]);
		expect(verifierPrompt()).toContain('Created [[Plan]]');
	});

	it('runs no corrective tool after Stop', async () => {
		const controller = new AbortController();
		// Stop arrives while the corrective dispatch (3rd structured call) is in flight.
		llm.onStructured = () => { if (llm.structured.length === 3) controller.abort(); };
		const { created } = await run(
			[{ calls: [WRITE], done: true }, RETRY, { calls: [write('Fix')], done: true }],
			{ signal: controller.signal },
		);
		expect(created).toEqual(['AI/Plan.md']);
	});
});
