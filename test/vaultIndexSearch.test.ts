/**
 * Vault index hybrid search: 0.7 × cosine + 0.3 × normalised BM25, with a
 * BM25-only fallback when the query cannot be embedded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const embed = vi.hoisted(() => ({ failQuery: false }));

// Vector = [mentions "apple", mentions "banana", 1]: enough to rank by topic.
vi.mock('../src/llm_core', async (orig) => {
	const real = await orig<typeof import('../src/llm_core')>();
	return {
		...real,
		getEmbedding: vi.fn(async (_c: unknown, t: string) => {
			if (embed.failQuery && t.length < 60) throw new Error('down');
			return { vector: [/apple/i.test(t) ? 1 : 0, /banana/i.test(t) ? 1 : 0, 0.1], model: 'm' };
		}),
	};
});

import { VaultIndex } from '../src/memory/vault_index';
import type { App, TFile } from 'obsidian';
import { createFakeApp } from './mocks/fakeVault';
import { DEFAULT_SETTINGS } from '../src/settings';

const body = (topic: string) => `${topic} `.repeat(10);
const NOTES = [
	{ path: 'apple.md', content: body('apple orchard harvest') },
	{ path: 'banana.md', content: body('banana plantation export') },
	{ path: 'other.md', content: body('granite quarry machinery') },
];

async function build(notes = NOTES) {
	const index = new VaultIndex(fs.mkdtempSync(path.join(os.tmpdir(), 'vz-search-')));
	const app = createFakeApp(notes);
	await index.reindexVault(app as unknown as App, DEFAULT_SETTINGS);
	return { index, app };
}

beforeEach(() => { embed.failQuery = false; });

describe('search', () => {
	it('ranks the matching note first and drops notes below the threshold', async () => {
		const { index } = await build();
		const r = await index.search('apple harvest', DEFAULT_SETTINGS);
		expect(r.map(x => x.chunk.path)).toEqual(['apple.md']);
		expect(r[0]?.bm25_score).toBe(1);
		expect(r[0]?.score).toBeCloseTo(0.7 * (r[0]?.vector_score ?? 0) + 0.3, 6);
	});

	it('falls back to word matching alone when the query cannot be embedded', async () => {
		const { index } = await build();
		embed.failQuery = true;
		const r = await index.search('banana export', DEFAULT_SETTINGS);
		expect(r.map(x => x.chunk.path)).toEqual(['banana.md']);
		expect(r[0]).toMatchObject({ vector_score: 0, bm25_score: 1, score: 1 });
	});

	it('returns nothing for an empty index', async () => {
		const { index } = await build([]);
		expect(await index.search('apple', DEFAULT_SETTINGS)).toEqual([]);
	});

	it('finds text added after an earlier search', async () => {
		const { index, app } = await build();
		embed.failQuery = true;
		expect(await index.search('zeppelin', DEFAULT_SETTINGS)).toEqual([]);
		const file = app.vault.getMarkdownFiles().find(f => f.path === 'other.md') as unknown as TFile;
		app.vault.cachedRead = async () => body('zeppelin hangar mooring');
		await index.indexFile(file, app as unknown as App, DEFAULT_SETTINGS);
		const r = await index.search('zeppelin', DEFAULT_SETTINGS);
		expect(r.map(x => x.chunk.path)).toEqual(['other.md']);
	});
});
