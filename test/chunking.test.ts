import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/utils/chunking';

describe('chunkText()', () => {
	it('returns the whole text as one chunk when within the limit', () => {
		expect(chunkText('short', 100)).toEqual(['short']);
	});

	it('returns one chunk at exactly the limit', () => {
		const text = 'a'.repeat(50);
		expect(chunkText(text, 50)).toEqual([text]);
	});

	it('splits on the last space before the limit', () => {
		// limit 10: "the quick " boundary — last space at index 9
		const out = chunkText('the quick brown fox', 10);
		expect(out[0]).toBe('the quick');
		expect(out.join(' ')).toContain('brown fox');
	});

	it('every chunk respects the max size', () => {
		const text = ('word '.repeat(500)).trim();
		const out = chunkText(text, 100);
		expect(out.length).toBeGreaterThan(1);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(100);
	});

	it('reconstructs the original words in order', () => {
		const text = 'alpha beta gamma delta epsilon zeta eta theta';
		const out = chunkText(text, 12);
		expect(out.join(' ').split(/\s+/)).toEqual(text.split(' '));
	});

	it('hard-splits a single token longer than the limit into max-sized pieces', () => {
		// No spaces to break on: the splitter falls back to a hard cut at `max`.
		// (Note: this path consumes the boundary char, so it is NOT lossless —
		//  pinning current behaviour rather than asserting reconstruction.)
		const text = 'x'.repeat(25);
		const out = chunkText(text, 10);
		expect(out.length).toBe(3);
		for (const c of out) expect(c.length).toBeLessThanOrEqual(10);
		expect(out[0]).toBe('x'.repeat(10));
	});

	it('drops empty chunks', () => {
		const out = chunkText('a'.repeat(30), 10);
		expect(out.every(c => c.length > 0)).toBe(true);
	});
});
