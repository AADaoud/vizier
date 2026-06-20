import { describe, it, expect } from 'vitest';
import { resolveNoteTarget } from '../src/agent/tool_execution';
import { createFakeApp } from './mocks/fakeVault';
import type { App } from 'obsidian';

// v0.7-only: agent tooling. Covers the folder-targeting / disambiguation added
// to read_note and edit_note.

const app = createFakeApp([
	{ path: 'Clips/Bitcoin.md' },
	{ path: 'Projects/Bitcoin.md' },
	{ path: 'Projects/2026/Roadmap.md' },
	{ path: 'Unique Title.md' },
]) as unknown as App;

describe('resolveNoteTarget()', () => {
	it('resolves an unambiguous basename', () => {
		expect(resolveNoteTarget(app, 'Unique Title').file?.path).toBe('Unique Title.md');
	});

	it('resolves an exact full path (with or without .md)', () => {
		expect(resolveNoteTarget(app, 'Projects/Bitcoin').file?.path).toBe('Projects/Bitcoin.md');
		expect(resolveNoteTarget(app, 'Projects/Bitcoin.md').file?.path).toBe('Projects/Bitcoin.md');
	});

	it('reports candidates when a basename is ambiguous', () => {
		const { file, error } = resolveNoteTarget(app, 'Bitcoin');
		expect(file).toBeUndefined();
		expect(error).toContain('ambiguous');
		expect(error).toContain('Clips/Bitcoin.md');
		expect(error).toContain('Projects/Bitcoin.md');
	});

	it('disambiguates via the folder argument', () => {
		expect(resolveNoteTarget(app, 'Bitcoin', 'Clips').file?.path).toBe('Clips/Bitcoin.md');
		expect(resolveNoteTarget(app, 'Bitcoin', 'Projects').file?.path).toBe('Projects/Bitcoin.md');
	});

	it('folder scoping includes subfolders', () => {
		expect(resolveNoteTarget(app, 'Roadmap', 'Projects').file?.path).toBe('Projects/2026/Roadmap.md');
	});

	it('errors when the basename is not in the given folder', () => {
		const { file, error } = resolveNoteTarget(app, 'Bitcoin', 'Reflections');
		expect(file).toBeUndefined();
		expect(error).toContain('not found');
		expect(error).toContain('Reflections');
	});

	it('errors (not silently) when the note does not exist', () => {
		expect(resolveNoteTarget(app, 'Nonexistent').error).toContain('not found');
	});
});
