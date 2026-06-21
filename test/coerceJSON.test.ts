import { describe, it, expect } from 'vitest';
import { coerceJSON } from '../src/llm_core';

// v0.7-only: covers tolerant JSON parsing for thinking/cloud models (gemma4:31b)
// that wrap structured output in code fences or emit a <think> block first.

describe('coerceJSON()', () => {
	it('parses plain JSON', () => {
		expect(coerceJSON('{"a":1}')).toEqual({ a: 1 });
	});

	it('unwraps a ```json fence', () => {
		const raw = '```json\n{"relevant":true,"score":0.9}\n```';
		expect(coerceJSON(raw)).toEqual({ relevant: true, score: 0.9 });
	});

	it('unwraps a bare ``` fence', () => {
		expect(coerceJSON('```\n{"x":2}\n```')).toEqual({ x: 2 });
	});

	it('strips a <think> block before the JSON', () => {
		const raw = '<think>The item is about finance, clearly relevant.</think>\n{"relevant":true}';
		expect(coerceJSON(raw)).toEqual({ relevant: true });
	});

	it('handles think block + fenced json together', () => {
		const raw = '<think>reasoning…</think>\n```json\n{"score":0.7}\n```';
		expect(coerceJSON(raw)).toEqual({ score: 0.7 });
	});

	it('extracts the object span when there is prose around it', () => {
		const raw = 'Here is my answer:\n{"relevant": false, "score": 0.2}\nHope that helps!';
		expect(coerceJSON(raw)).toEqual({ relevant: false, score: 0.2 });
	});

	it('parses arrays too', () => {
		expect(coerceJSON('```json\n[1,2,3]\n```')).toEqual([1, 2, 3]);
	});

	it('throws when there is no JSON at all', () => {
		// The exact failure mode from gemma4:31b with format set.
		expect(() => coerceJSON('Score: 1\nRelevant: True')).toThrow();
	});
});
