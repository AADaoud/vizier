import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	today,
	sanitizeFilename,
	sanitizeTag,
	buildYamlTags,
	buildYamlArray,
	buildYamlTagArray,
	buildDateField,
	ensureFolder,
	deduplicatePath,
} from '../src/utils/noteBuilder';
import { createFakeApp } from './mocks/fakeVault';
import type { App } from 'obsidian';

afterEach(() => vi.useRealTimers());

describe('today()', () => {
	it('returns an ISO YYYY-MM-DD date', () => {
		expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('reflects the current date', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-20T13:45:00Z'));
		expect(today()).toBe('2026-06-20');
	});
});

describe('sanitizeFilename()', () => {
	it('strips filesystem-illegal characters', () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
	});

	it('collapses runs of dashes', () => {
		expect(sanitizeFilename('a///b')).toBe('a-b');
	});

	it('falls back to "untitled" for empty/whitespace input', () => {
		expect(sanitizeFilename('')).toBe('untitled');
		expect(sanitizeFilename('   ')).toBe('untitled');
	});

	it('preserves ordinary names', () => {
		expect(sanitizeFilename('My Note 2026')).toBe('My Note 2026');
	});
});

describe('sanitizeTag()', () => {
	it('lowercases and hyphenates whitespace', () => {
		expect(sanitizeTag('Cold War')).toBe('cold-war');
	});

	it('drops disallowed punctuation', () => {
		expect(sanitizeTag('C++ & Rust!')).toBe('c-rust');
	});

	it('trims leading/trailing dashes', () => {
		expect(sanitizeTag('  -- hello -- ')).toBe('hello');
	});

	it('returns empty string when nothing survives', () => {
		expect(sanitizeTag('!!!')).toBe('');
	});

	it('keeps underscores and digits', () => {
		expect(sanitizeTag('era_1939')).toBe('era_1939');
	});
});

describe('buildYamlTags()', () => {
	it('emits a two-space-indented bullet list', () => {
		expect(buildYamlTags(['Cold War', 'history'])).toBe('  - cold-war\n  - history');
	});

	it('dedups after sanitization', () => {
		expect(buildYamlTags(['Cold War', 'cold war', 'COLD-WAR'])).toBe('  - cold-war');
	});

	it('drops tags that sanitize to empty', () => {
		expect(buildYamlTags(['!!!', 'valid'])).toBe('  - valid');
	});

	it('returns empty string for no usable tags', () => {
		expect(buildYamlTags([])).toBe('');
		expect(buildYamlTags(['!!!'])).toBe('');
	});
});

describe('buildYamlArray()', () => {
	it('returns "[]" for an empty list', () => {
		expect(buildYamlArray([])).toBe('[]');
	});

	it('quotes each item with a leading newline', () => {
		expect(buildYamlArray(['Alice', 'Bob'])).toBe('\n  - "Alice"\n  - "Bob"');
	});

	it('escapes embedded double quotes', () => {
		expect(buildYamlArray(['the "best"'])).toBe('\n  - "the \\"best\\""');
	});
});

describe('buildYamlTagArray()', () => {
	it('returns "[]" when nothing survives', () => {
		expect(buildYamlTagArray([])).toBe('[]');
		expect(buildYamlTagArray(['###'])).toBe('[]');
	});

	it('sanitizes, dedups, and indents', () => {
		expect(buildYamlTagArray(['Cold War', 'cold war'])).toBe('\n  - cold-war');
	});
});

describe('buildDateField()', () => {
	it('leaves ISO dates unquoted', () => {
		expect(buildDateField('2026-06-20')).toBe('2026-06-20');
		expect(buildDateField('  2026-06-20 ')).toBe('2026-06-20');
	});

	it('quotes non-ISO values', () => {
		expect(buildDateField('circa 1500')).toBe('"circa 1500"');
	});

	it('returns empty quotes for blank input', () => {
		expect(buildDateField('')).toBe('""');
		expect(buildDateField('   ')).toBe('""');
	});
});

describe('ensureFolder()', () => {
	it('creates a folder that does not exist', async () => {
		const app = createFakeApp([]);
		await ensureFolder(app as unknown as App, 'Clips');
		expect(app.__createdFolders).toEqual(['Clips']);
	});

	it('does nothing when the folder already exists', async () => {
		const app = createFakeApp([{ path: 'Clips' }]);
		await ensureFolder(app as unknown as App, 'Clips');
		expect(app.__createdFolders).toEqual([]);
	});

	it('is a no-op for an empty path', async () => {
		const app = createFakeApp([]);
		await ensureFolder(app as unknown as App, '');
		expect(app.__createdFolders).toEqual([]);
	});
});

describe('deduplicatePath()', () => {
	it('returns the plain path when free', async () => {
		const app = createFakeApp([]);
		expect(await deduplicatePath(app as unknown as App, 'Clips/note')).toBe('Clips/note.md');
	});

	it('appends -2, -3 … on collisions', async () => {
		const app = createFakeApp([
			{ path: 'Clips/note.md' },
			{ path: 'Clips/note-2.md' },
		]);
		expect(await deduplicatePath(app as unknown as App, 'Clips/note')).toBe('Clips/note-3.md');
	});

	it('honours a custom extension', async () => {
		const app = createFakeApp([]);
		expect(await deduplicatePath(app as unknown as App, 'x', '.canvas')).toBe('x.canvas');
	});
});
