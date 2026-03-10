import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chunkText, mapReduceSummarize } from './chunking';

// Mock callOllama so tests don't make real HTTP calls
vi.mock('./ollama', () => ({
	callOllama: vi.fn(async () => 'mocked summary'),
}));

import { callOllama } from './ollama';
const mockedCallOllama = vi.mocked(callOllama);

beforeEach(() => {
	mockedCallOllama.mockClear();
});

// ── chunkText ────────────────────────────────────────────────────────────────

describe('chunkText', () => {
	it('returns the whole text as one chunk when it fits', () => {
		const text = 'hello world';
		expect(chunkText(text, 100)).toEqual(['hello world']);
	});

	it('returns single-element array when text length equals maxChars', () => {
		const text = 'abcde';
		expect(chunkText(text, 5)).toEqual(['abcde']);
	});

	it('splits at word boundaries', () => {
		const text = 'one two three four five';
		// maxChars = 10 → first candidate end = 10, lastIndexOf(' ', 10) = 7 (before 'three')
		const chunks = chunkText(text, 10);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(10 + 5); // word boundary slack
		}
	});

	it('produces no empty chunks', () => {
		const text = 'a b c d e f g h i j k';
		const chunks = chunkText(text, 5);
		for (const chunk of chunks) {
			expect(chunk.length).toBeGreaterThan(0);
		}
	});

	it('handles empty string (early-return path, callers should guard)', () => {
		// text.length (0) <= maxChars → returns [text] immediately before the filter runs
		expect(chunkText('', 100)).toEqual(['']);
	});

	it('joins all chunks back to original content', () => {
		const text = 'The quick brown fox jumps over the lazy dog';
		const chunks = chunkText(text, 10);
		// Re-joining with spaces should reproduce the original text
		expect(chunks.join(' ')).toBe(text);
	});
});

// ── mapReduceSummarize ───────────────────────────────────────────────────────

const MODEL = 'test-model';
const OLLAMA_URL = 'http://localhost:11434';

describe('mapReduceSummarize', () => {
	it('calls summarizeFull path for short text (≤4000 chars)', async () => {
		const shortText = 'A'.repeat(100);
		const result = await mapReduceSummarize(shortText, MODEL, 'article', OLLAMA_URL);
		expect(result).toBe('mocked summary');
		// One call: direct summarize
		expect(mockedCallOllama).toHaveBeenCalledTimes(1);
		const [req] = mockedCallOllama.mock.calls[0] as [{ messages: Array<{ content: string }> }][];
		const userMsg = req.messages.find(m => m.content.includes('CONTENT:'));
		expect(userMsg).toBeTruthy();
	});

	it('calls chunk + combine path for long text (>4000 chars)', async () => {
		// Build text > 4000 chars, multiple words so chunking works
		const longText = ('word '.repeat(100) + '\n').repeat(10); // ~1000+ chars each line
		await mapReduceSummarize(longText, MODEL, 'video', OLLAMA_URL);
		// Should call chunk summaries + one combine → more than 1 call
		expect(mockedCallOllama.mock.calls.length).toBeGreaterThan(1);
		// Last call should be the combine prompt
		const lastReq = mockedCallOllama.mock.calls.at(-1)![0] as { messages: Array<{ content: string }> };
		const userMsg = lastReq.messages.find(m => m.content.includes('SECTION SUMMARIES:'));
		expect(userMsg).toBeTruthy();
	});

	it('uses detailed prompts when detailed=true', async () => {
		const shortText = 'A'.repeat(100);
		await mapReduceSummarize(shortText, MODEL, 'lecture', OLLAMA_URL, true);
		const [req] = mockedCallOllama.mock.calls[0] as [{ messages: Array<{ content: string }> }][];
		const userMsg = req.messages.find(m => m.content.includes('NOTES:'));
		expect(userMsg).toBeTruthy();
	});
});
