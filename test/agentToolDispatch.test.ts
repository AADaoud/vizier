/**
 * Agent tool dispatch: tools that wrap slash-command handlers must reach the
 * handler, and a tool that cannot run must report a real failure (`ERROR:`).
 */
import { describe, it, expect, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ called: [] as Array<{ name: string; args: unknown[] }> }));

vi.mock('../src/commands/reflectionCommands', async (orig) => {
	const real = await orig<typeof import('../src/commands/reflectionCommands')>();
	const spy = (name: string, reply: string) => vi.fn(async (...args: unknown[]) => {
		handlers.called.push({ name, args });
		(args[2] as (role: string, content: string) => void)('assistant', reply);
	});
	return {
		...real,
		executeContradict: spy('contradict', 'contradict ran'),
		executeRecluster: spy('recluster', 'recluster ran'),
		executeThesis: spy('thesis', 'thesis ran'),
	};
});

import { executeTool } from '../src/agent/tool_execution';
import type { ToolCall } from '../src/schemas/index';
import type { App } from 'obsidian';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

async function run(name: string, params: Record<string, unknown>, activePath?: string) {
	handlers.called.length = 0;
	const app = createFakeApp([{ path: 'x.md', content: 'x' }, { path: 'y.md', content: 'y' }], activePath);
	return executeTool({ name, params } as unknown as ToolCall, app as unknown as App, DEFAULT_SETTINGS);
}

describe('tools that wrap slash-command handlers', () => {
	it('recluster reaches its handler with the folder', async () => {
		const r = await run('recluster', { folder: 'Clips' });
		expect(r.output).toBe('recluster ran');
		expect(handlers.called.map(c => [c.name, c.args[0]])).toEqual([['recluster', 'Clips']]);
	});

	it('thesis reaches its handler with the topic', async () => {
		const r = await run('thesis', { topic: 'BTC' });
		expect(r.output).toBe('thesis ran');
		expect(handlers.called.map(c => [c.name, c.args[0]])).toEqual([['thesis', 'BTC']]);
	});

	it('contradict_note checks the named note, not the active one', async () => {
		const r = await run('contradict_note', { note_name: 'Y' }, 'x.md');
		expect(r.output).toBe('contradict ran');
		expect(handlers.called).toHaveLength(1);
		expect((handlers.called[0]?.args[6] as { path: string }).path).toBe('y.md');
	});

	it('contradict_note falls back to the active note', async () => {
		await run('contradict_note', {}, 'x.md');
		expect((handlers.called[0]?.args[6] as { path: string }).path).toBe('x.md');
	});

	it('contradict_note reports a failure when there is no note to check', async () => {
		const r = await run('contradict_note', { note_name: 'missing' });
		expect(r.output).toMatch(/^ERROR:/);
		expect(handlers.called).toEqual([]);
	});
});

describe('transcribe', () => {
	it('reports a failure, because the server has no transcription route', async () => {
		const r = await run('transcribe', { path: 'audio.mp3' });
		expect(r.output).toMatch(/^ERROR:.*not available/i);
		expect(r.output).not.toMatch(/slash command/i);
	});
});
