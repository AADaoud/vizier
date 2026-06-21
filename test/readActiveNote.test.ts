import { describe, it, expect } from 'vitest';
import { executeTool } from '../src/agent/tool_execution';
import { getToolByName } from '../src/agent/tool_schemas';
import { createFakeApp } from './mocks/fakeVault';
import type { App } from 'obsidian';
import type { AIAgentSettings } from '../src/settings';
import type { ToolCall } from '../src/schemas/index';

// v0.7-only: covers the read_active_note tool that replaced auto-injecting the
// active note's content into the system prompt.

const settings = { ollamaUrl: 'http://x', serverUrl: 'http://y' } as unknown as AIAgentSettings;
const call: ToolCall = { name: 'read_active_note', params: {} };

describe('read_active_note tool', () => {
	it('is registered and always available', () => {
		const def = getToolByName('read_active_note');
		expect(def).toBeDefined();
		expect(def?.alwaysAvailable).toBe(true);
	});

	it('returns the active note name and content', async () => {
		const app = createFakeApp(
			[{ path: 'Clips/Open Note.md', content: '# Heading\n\nbody text' }],
			'Clips/Open Note.md',
		) as unknown as App;

		const r = await executeTool(call, app, settings);
		expect(r.ok).toBe(true);
		expect(r.output).toContain('[[Open Note]]');
		expect(r.output).toContain('body text');
	});

	it('reports clearly when no note is open', async () => {
		const app = createFakeApp([{ path: 'a.md', content: 'x' }]) as unknown as App; // no active
		const r = await executeTool(call, app, settings);
		expect(r.output).toMatch(/No note is currently open/i);
	});

	it('rejects a non-markdown active file', async () => {
		const app = createFakeApp(
			[{ path: 'image.png', content: '' }],
			'image.png',
		) as unknown as App;
		const r = await executeTool(call, app, settings);
		expect(r.output).toMatch(/not a markdown note/i);
	});

	it('truncates long content at the provided char budget', async () => {
		const app = createFakeApp(
			[{ path: 'Big.md', content: 'z'.repeat(5000) }],
			'Big.md',
		) as unknown as App;
		const r = await executeTool(call, app, settings, { readNoteChars: 1000 });
		expect(r.output).toContain('truncated at 1000 chars');
	});
});
