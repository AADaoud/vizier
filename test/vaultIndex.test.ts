/**
 * Vault index: change detection, chunk tracking, per-file serialisation and
 * persistence (US-11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const embed = vi.hoisted(() => ({
	model: 'embed-a',
	fail: (_text: string): boolean => false,
	calls: [] as string[],
}));

vi.mock('../src/llm_core', async (orig) => {
	const real = await orig<typeof import('../src/llm_core')>();
	return {
		...real,
		getEmbedding: vi.fn(async (_c: unknown, t: string) => {
			embed.calls.push(t);
			if (embed.fail(t)) throw new Error('embedding host down');
			return { vector: [t.length, 1, 2], model: embed.model };
		}),
	};
});

import { VaultIndex } from '../src/memory/vault_index';
import type { App, TFile } from 'obsidian';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'vz-index-')); }
const padded = (s: string) => s + ' filler text '.repeat(20);
const section = (i: number, word = 'word') => `## Section ${i}\n` + `${word} `.repeat(40);
type Fake = ReturnType<typeof createFakeApp>;
const asApp = (a: Fake) => a as unknown as App;
const firstFile = (a: Fake) => a.vault.getMarkdownFiles()[0] as unknown as TFile;
function setContent(a: Fake, content: string) { a.vault.cachedRead = async () => content; }
const index1 = (index: VaultIndex, app: Fake) => index.indexFile(firstFile(app), asApp(app), DEFAULT_SETTINGS);

beforeEach(() => {
	embed.model = 'embed-a';
	embed.fail = () => false;
	embed.calls.length = 0;
});

describe('change detection', () => {
	it.each([
		['an em-dash', 'Ideas — notes on things'],
		['curly quotes', 'Note – “quoted” text'],
		['CJK text', '日本語のノート、漢字とかな'],
		['emoji', 'Launch plan 🚀 and review ✅'],
	])('indexes a note containing %s', async (_label, text) => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'a.md', content: padded(text) }]);
		expect(await index1(index, app)).toEqual({ added: 1, failed: 0 });
	});

	it('re-embeds a chunk when only its last character changes', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'b.md', content: padded('Shopping list: apples') + 'x' }]);
		await index1(index, app);
		setContent(app, padded('Shopping list: apples') + 'y');
		expect((await index1(index, app)).added).toBe(1);
	});

	it('issues no embedding for an unchanged note', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'b.md', content: padded('Shopping list: apples') }]);
		await index1(index, app);
		embed.calls.length = 0;
		expect((await index1(index, app)).added).toBe(0);
		expect(embed.calls).toEqual([]);
	});

	it('re-embeds only the new chunk when a section is inserted', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'c.md', content: [section(0), section(1), section(2)].join('\n') }]);
		await index1(index, app);
		embed.calls.length = 0;
		setContent(app, [section(0), section(9, 'fresh'), section(1), section(2)].join('\n'));
		expect((await index1(index, app)).added).toBe(1);
		expect(embed.calls).toHaveLength(1);
		expect(embed.calls[0]).toContain('Section 9');
		expect(index.getStats().total_chunks).toBe(4);
	});

	it('re-embeds every chunk after the embedding model changes', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'c.md', content: [section(0), section(1)].join('\n') }]);
		await index.reindexVault(asApp(app), DEFAULT_SETTINGS);
		embed.model = 'embed-b';
		const r = await index.reindexVault(asApp(app), DEFAULT_SETTINGS);
		expect(r.chunksAdded).toBe(2);
		// A third run with the same model has nothing left to do.
		expect((await index.reindexVault(asApp(app), DEFAULT_SETTINGS)).chunksAdded).toBe(0);
	});
});

describe('chunk tracking', () => {
	it('drops chunks past the end when a note shrinks', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'c.md', content: [0, 1, 2, 3, 4].map(i => section(i)).join('\n') }]);
		await index1(index, app);
		expect(index.getStats().total_chunks).toBe(5);
		setContent(app, section(0));
		await index1(index, app);
		expect(index.getStats().total_chunks).toBe(1);
	});

	it('drops every chunk when a note shrinks below the indexing minimum', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'c.md', content: section(0) }]);
		await index1(index, app);
		setContent(app, 'short');
		await index1(index, app);
		expect(index.getStats()).toEqual({ total_chunks: 0, total_files: 0 });
	});

	it('keeps the old chunk when re-embedding an edited chunk fails', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'c.md', content: [section(0), section(1)].join('\n') }]);
		await index1(index, app);
		embed.fail = () => true;
		setContent(app, [section(0), section(1, 'changed')].join('\n'));
		expect(await index1(index, app)).toEqual({ added: 0, failed: 1 });
		expect(index.getStats().total_chunks).toBe(2);
	});

	it('does not duplicate chunks when two index calls for one note overlap', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'd.md', content: padded('Plain ascii note body') }]);
		const results = await Promise.all([index1(index, app), index1(index, app)]);
		expect(index.getStats().total_chunks).toBe(1);
		expect(results.map(r => r.added)).toEqual([1, 0]);
	});

	it('removes chunks of a removed file even if an index call is in flight', async () => {
		const index = new VaultIndex(tmpDir());
		const app = createFakeApp([{ path: 'd.md', content: padded('Plain ascii note body') }]);
		const indexing = index1(index, app);
		const removing = index.removeFile('d.md');
		await Promise.all([indexing, removing]);
		expect(index.getStats().total_chunks).toBe(0);
	});
});

describe('full reindex', () => {
	it('does not abort because notes contain typographic punctuation', async () => {
		const index = new VaultIndex(tmpDir());
		const notes = Array.from({ length: 15 }, (_, i) => ({ path: `n${i}.md`, content: padded(`Note ${i} – “quoted” text`) }));
		const r = await index.reindexVault(asApp(createFakeApp(notes)), DEFAULT_SETTINGS);
		expect(r).toMatchObject({ aborted: false, chunksAdded: 15, embedFailures: 0 });
	});

	it('aborts after 12 consecutive embedding failures', async () => {
		const index = new VaultIndex(tmpDir());
		const notes = Array.from({ length: 20 }, (_, i) => ({ path: `n${i}.md`, content: padded(`Note ${i}`) }));
		embed.fail = t => t.startsWith('Note');
		const r = await index.reindexVault(asApp(createFakeApp(notes)), DEFAULT_SETTINGS);
		expect(r).toMatchObject({ aborted: true, embedFailures: 12, chunksAdded: 0 });
	});

	it('does not count unreadable files toward the embedding circuit breaker', async () => {
		const index = new VaultIndex(tmpDir());
		const notes = Array.from({ length: 20 }, (_, i) => ({ path: `n${i}.md`, content: padded(`Note ${i}`) }));
		const app = createFakeApp(notes);
		const read = app.vault.cachedRead;
		app.vault.cachedRead = async (f) => {
			if (f.path !== 'n19.md') throw new Error('EIO');
			return read(f);
		};
		const r = await index.reindexVault(asApp(app), DEFAULT_SETTINGS);
		expect(r).toMatchObject({ aborted: false, chunksAdded: 1, embedFailures: 0 });
	});
});

describe('persistence', () => {
	it('reloads saved chunks and leaves no temp file behind', async () => {
		const dir = tmpDir();
		const app = createFakeApp([{ path: 'a.md', content: padded('Ideas — notes on things') }]);
		await index1(new VaultIndex(dir), app);
		expect(fs.readdirSync(dir)).toEqual(['vault_index.json']);

		const reloaded = new VaultIndex(dir);
		embed.calls.length = 0;
		expect((await index1(reloaded, app)).added).toBe(0);
		expect(embed.calls).toEqual([]);
		expect(reloaded.getStats().total_chunks).toBe(1);
	});

	it('keeps a corrupt index file aside instead of overwriting it', async () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, 'vault_index.json'), '[{"path":"a.md","chu');
		const index = new VaultIndex(dir);
		const app = createFakeApp([{ path: 'a.md', content: padded('Plain ascii note body') }]);
		expect((await index1(index, app)).added).toBe(1);
		const kept = fs.readdirSync(dir).filter(f => f.startsWith('vault_index.json.corrupt-'));
		expect(kept).toHaveLength(1);
		expect(fs.readFileSync(path.join(dir, kept[0] as string), 'utf-8')).toBe('[{"path":"a.md","chu');
	});

	it('re-embeds chunks stored by an older index format', async () => {
		const dir = tmpDir();
		const text = padded('Plain ascii note body');
		const legacy = [{ path: 'a.md', basename: 'a', chunk_id: 'a.md#0', text_hash: 'UGxhaW4gYXNj', text, vector: [9, 9, 9], indexed_at: 1 }];
		fs.writeFileSync(path.join(dir, 'vault_index.json'), JSON.stringify(legacy));
		const index = new VaultIndex(dir);
		const app = createFakeApp([{ path: 'a.md', content: text }]);
		expect((await index1(index, app)).added).toBe(1);
		expect(index.getStats().total_chunks).toBe(1);
	});
});
