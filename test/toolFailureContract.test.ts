/**
 * Every real tool failure starts with `ERROR:` (so the loop counts it as a
 * failure), and an empty result is not a failure.
 */
import { describe, it, expect } from 'vitest';
import { executeTool } from '../src/agent/tool_execution';
import type { ToolCall } from '../src/schemas/index';
import type { App } from 'obsidian';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

const NOTES = [
	{ path: 'Notes/Alpha.md', content: 'one two two three' },
	{ path: 'A/Dup.md', content: 'a' },
	{ path: 'B/Dup.md', content: 'b' },
];

async function run(name: string, params: Record<string, unknown>, activePath?: string) {
	const app = createFakeApp(NOTES, activePath);
	return executeTool({ name, params } as unknown as ToolCall, app as unknown as App, DEFAULT_SETTINGS);
}

describe('failures start with ERROR:', () => {
	it.each<[string, string, Record<string, unknown>, RegExp]>([
		['read_note on a missing note', 'read_note', { name: 'Nope' }, /not found/i],
		['read_note on an ambiguous name', 'read_note', { name: 'Dup' }, /A\/Dup\.md/],
		['read_active_note with nothing open', 'read_active_note', {}, /No note is currently open/],
		['edit_note on a missing note', 'edit_note', { name: 'Nope', find: 'a', replace: 'b' }, /not found/i],
		['edit_note when the find string is absent', 'edit_note', { name: 'Alpha', find: 'zzz', replace: 'b' }, /Find string not found/],
		['edit_note when the find string is not unique', 'edit_note', { name: 'Alpha', find: 'two', replace: 'b' }, /appears 2 times/],
		['bridge with an unknown entity', 'bridge', { entity_a: 'Nobody', entity_b: 'Noone' }, /Entity not found/],
		['add_claim on a missing note', 'add_claim', { note_name: 'Nope', text: 'x' }, /Note not found/],
		['list_claims on a missing note', 'list_claims', { note_name: 'Nope' }, /Note not found/],
		['an unknown tool', 'no_such_tool', {}, /Unknown tool/],
	])('%s', async (_label, name, params, detail) => {
		const r = await run(name, params);
		expect(r.output).toMatch(/^ERROR: /);
		expect(r.output).toMatch(detail);
		expect(r.ok).toBe(false);
	});
});

describe('an empty result is not a failure', () => {
	it('vault_search with no matches', async () => {
		const r = await run('vault_search', { query: 'qqqqzzzz' });
		expect(r.ok).toBe(true);
		expect(r.output).toMatch(/No notes found/);
	});

	it('read_note on an existing note', async () => {
		const r = await run('read_note', { name: 'Alpha' });
		expect(r.ok).toBe(true);
		expect(r.output).toContain('one two two three');
	});
});
