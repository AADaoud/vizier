import { describe, it, expect } from 'vitest';
import {
	getNotesByType,
	getEntityNotes,
	findEntityByName,
	getLinkGraph,
	getNotesModifiedSince,
	getNotesByFrontmatterTag,
} from '../src/utils/vaultQuery';
import { createFakeApp } from './mocks/fakeVault';
import type { App } from 'obsidian';

describe('getNotesByType()', () => {
	it('matches notes by frontmatter type', () => {
		const app = createFakeApp([
			{ path: 'a.md', frontmatter: { type: 'clip' } },
			{ path: 'b.md', frontmatter: { type: 'write' } },
			{ path: 'c.md', frontmatter: { type: 'clip' } },
			{ path: 'd.md' },
		]);
		const clips = getNotesByType(app as unknown as App, 'clip');
		expect(clips.map(f => f.path).sort()).toEqual(['a.md', 'c.md']);
	});

	it('returns [] when nothing matches', () => {
		const app = createFakeApp([{ path: 'a.md', frontmatter: { type: 'write' } }]);
		expect(getNotesByType(app as unknown as App, 'clip')).toEqual([]);
	});
});

describe('getEntityNotes()', () => {
	it('matches entity-typed notes regardless of folder', () => {
		const app = createFakeApp([
			{ path: 'Random/x.md', frontmatter: { type: 'person' } },
			{ path: 'Random/y.md', frontmatter: { type: 'idea' } },
			{ path: 'Random/z.md', frontmatter: { type: 'clip' } },
		]);
		const out = getEntityNotes(app as unknown as App, []);
		expect(out.map(f => f.path).sort()).toEqual(['Random/x.md', 'Random/y.md']);
	});

	it('matches by folder membership when type is absent', () => {
		const app = createFakeApp([
			{ path: 'People/alice.md' },
			{ path: 'People/sub/bob.md' },
			{ path: 'Other/carol.md' },
		]);
		const out = getEntityNotes(app as unknown as App, ['People']);
		expect(out.map(f => f.path).sort()).toEqual(['People/alice.md', 'People/sub/bob.md']);
	});

	it('tolerates trailing slashes in folder config', () => {
		const app = createFakeApp([{ path: 'People/alice.md' }]);
		const out = getEntityNotes(app as unknown as App, ['People/']);
		expect(out.map(f => f.path)).toEqual(['People/alice.md']);
	});
});

describe('findEntityByName()', () => {
	const app = createFakeApp([
		{ path: 'People/Alice Smith.md', frontmatter: { name: 'Alice Smith', aliases: ['Ali'] } },
		{ path: 'People/Bob.md', frontmatter: { title: 'Robert Jones' } },
		{ path: 'Notes/random.md' },
	]) as unknown as App;

	it('matches on basename, case-insensitively', () => {
		expect(findEntityByName(app, 'alice smith')?.path).toBe('People/Alice Smith.md');
	});

	it('matches on the frontmatter name field', () => {
		expect(findEntityByName(app, 'Alice Smith')?.path).toBe('People/Alice Smith.md');
	});

	it('matches on the frontmatter title field', () => {
		expect(findEntityByName(app, 'robert jones')?.path).toBe('People/Bob.md');
	});

	it('matches on an alias', () => {
		expect(findEntityByName(app, 'ali')?.path).toBe('People/Alice Smith.md');
	});

	it('returns null when there is no match', () => {
		expect(findEntityByName(app, 'nobody')).toBeNull();
	});
});

describe('getLinkGraph()', () => {
	it('builds an adjacency list confined to the entity folders', () => {
		const app = createFakeApp([
			{ path: 'E/a.md', links: ['E/b.md', 'Other/x.md'] },
			{ path: 'E/b.md', links: ['E/a.md'] },
			{ path: 'Other/x.md', links: ['E/a.md'] },
		]);
		const graph = getLinkGraph(app as unknown as App, ['E']);
		// Only E/* nodes are present; links to Other/* are filtered out.
		expect([...graph.keys()].sort()).toEqual(['E/a.md', 'E/b.md']);
		expect(graph.get('E/a.md')).toEqual(['E/b.md']);
		expect(graph.get('E/b.md')).toEqual(['E/a.md']);
	});

	it('returns an empty graph when no folders are given', () => {
		const app = createFakeApp([{ path: 'E/a.md', links: ['E/b.md'] }]);
		expect(getLinkGraph(app as unknown as App, []).size).toBe(0);
	});
});

describe('getNotesModifiedSince()', () => {
	it('includes only notes modified at/after the cutoff', () => {
		const app = createFakeApp([
			{ path: 'old.md', mtime: 1000 },
			{ path: 'edge.md', mtime: 5000 },
			{ path: 'new.md', mtime: 9000 },
		]);
		const out = getNotesModifiedSince(app as unknown as App, new Date(5000));
		expect(out.map(f => f.path).sort()).toEqual(['edge.md', 'new.md']);
	});
});

describe('getNotesByFrontmatterTag()', () => {
	it('matches array-valued tags case-insensitively and ignores a leading #', () => {
		const app = createFakeApp([
			{ path: 'a.md', frontmatter: { tags: ['History', 'war'] } },
			{ path: 'b.md', frontmatter: { tags: 'history' } },
			{ path: 'c.md', frontmatter: { tags: ['science'] } },
		]);
		const out = getNotesByFrontmatterTag(app as unknown as App, '#history');
		expect(out.map(f => f.path).sort()).toEqual(['a.md', 'b.md']);
	});

	it('returns [] when no note carries the tag', () => {
		const app = createFakeApp([{ path: 'a.md', frontmatter: { tags: ['x'] } }]);
		expect(getNotesByFrontmatterTag(app as unknown as App, 'y')).toEqual([]);
	});
});
