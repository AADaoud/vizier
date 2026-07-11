import { describe, it, expect } from 'vitest';
import { Prompts } from '../src/prompts';

describe('Prompts', () => {
	it('writeNote injects the topic verbatim', () => {
		const p = Prompts.writeNote('the fall of Rome');
		expect(p).toContain('the fall of Rome');
		expect(p).toMatch(/note-writing system/i);
	});

	it('findQueryTerms injects the query', () => {
		expect(Prompts.findQueryTerms('risc vs cisc')).toContain('"risc vs cisc"');
	});

	it('findRankResults injects both query and context', () => {
		const p = Prompts.findRankResults('cold war', 'NOTE A\nNOTE B');
		expect(p).toContain('"cold war"');
		expect(p).toContain('NOTE A');
		expect(p).toContain('NOTE B');
	});

	it('clipMetadata truncates the summary to 1000 chars', () => {
		const long = 'z'.repeat(5000);
		const p = Prompts.clipMetadata(long);
		expect(p).toContain('z'.repeat(1000));
		expect(p).not.toContain('z'.repeat(1001));
	});

	it('summarizeChunk ends with the completion-style "SUMMARY:" label', () => {
		const p = Prompts.summarizeChunk('article', 'some section text');
		expect(p).toContain('some section text');
		expect(p.trimEnd().endsWith('SUMMARY:')).toBe(true);
	});

	it('handwritingTranscribe without a hint never mentions an OCR draft', () => {
		const p = Prompts.handwritingTranscribe();
		expect(p).toMatch(/transcribe/i);
		expect(p).toContain('EMPTY');
		expect(p).not.toMatch(/draft/i);
	});

	it('handwritingTranscribe embeds the OCR hint as a cross-check', () => {
		const p = Prompts.handwritingTranscribe('n0isy 0cr t3xt');
		expect(p).toContain('n0isy 0cr t3xt');
		expect(p).toMatch(/cross-check/i);
	});

	it('prompt builders are pure and deterministic', () => {
		expect(Prompts.writeNote('x')).toBe(Prompts.writeNote('x'));
		expect(Prompts.summarizeChunk('a', 'b')).toBe(Prompts.summarizeChunk('a', 'b'));
	});
});
