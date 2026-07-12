import { describe, it, expect } from 'vitest';
import {
	arrayBufferToBase64, fitWithin, prepareImageForVision, MAX_VISION_EDGE,
	planBands, mergeBandTranscriptions, lineSimilarity,
} from '../src/utils/image';

function bytes(...values: number[]): ArrayBuffer {
	return new Uint8Array(values).buffer;
}

describe('arrayBufferToBase64', () => {
	it('matches Buffer encoding for small payloads', () => {
		const buf = bytes(0, 1, 2, 253, 254, 255);
		expect(arrayBufferToBase64(buf)).toBe(Buffer.from(buf).toString('base64'));
	});

	it('handles an empty buffer', () => {
		expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
	});

	it('matches Buffer encoding across the 32 KB chunk boundary', () => {
		const raw = new Uint8Array(0x8000 * 2 + 17); // spans three chunks, last partial
		for (let i = 0; i < raw.length; i++) raw[i] = i % 256;
		expect(arrayBufferToBase64(raw.buffer)).toBe(Buffer.from(raw).toString('base64'));
	});
});

describe('fitWithin', () => {
	it('leaves images at or under the max edge untouched', () => {
		expect(fitWithin(800, 600, 1280)).toEqual({ width: 800, height: 600 });
		expect(fitWithin(1280, 720, 1280)).toEqual({ width: 1280, height: 720 });
	});

	it('scales the longest edge down to the max, preserving aspect ratio', () => {
		expect(fitWithin(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
		expect(fitWithin(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 });
	});

	it('never returns a zero dimension for extreme aspect ratios', () => {
		const { width, height } = fitWithin(100000, 10, 1280);
		expect(width).toBe(1280);
		expect(height).toBeGreaterThanOrEqual(1);
	});

	it('handles zero-sized input without dividing by zero', () => {
		expect(fitWithin(0, 0, 1280)).toEqual({ width: 0, height: 0 });
	});
});

describe('prepareImageForVision', () => {
	it('falls back to raw base64 when image decoding is unavailable', async () => {
		// Node has no createImageBitmap/canvas — the decode path throws and the
		// original bytes must come back unmodified.
		const buf = bytes(1, 2, 3, 4);
		const prepared = await prepareImageForVision(buf, 'image/png');
		expect(prepared.reencoded).toBe(false);
		expect(prepared.base64).toBe(Buffer.from(buf).toString('base64'));
	});
});

describe('planBands', () => {
	it('keeps short images as a single band', () => {
		expect(planBands(1600, 1000).bands).toHaveLength(1);
		expect(planBands(4000, 3000).bands).toHaveLength(1);
	});

	it('slices a tall page into overlapping bands that cover it fully', () => {
		const { bands, scale } = planBands(2000, 6000);
		expect(bands.length).toBeGreaterThan(1);
		expect(bands.length).toBeLessThanOrEqual(6);
		expect(bands[0]?.y).toBe(0);
		const last = bands[bands.length - 1];
		expect((last?.y ?? 0) + (last?.height ?? 0)).toBe(6000);
		// consecutive bands overlap
		for (let i = 1; i < bands.length; i++) {
			const prev = bands[i - 1], cur = bands[i];
			expect(cur!.y).toBeLessThan(prev!.y + prev!.height);
		}
		// bands render at width-based scale
		expect(scale).toBeCloseTo(MAX_VISION_EDGE / 2000, 5);
	});

	it('caps the band count for extremely tall images', () => {
		expect(planBands(1000, 50000).bands.length).toBeLessThanOrEqual(6);
	});

	it('handles degenerate dimensions without slicing', () => {
		expect(planBands(0, 0).bands).toHaveLength(1);
		expect(planBands(10, 5).bands).toHaveLength(1);
	});
});

describe('lineSimilarity', () => {
	it('is 1 for identical lines and 0 for disjoint lines', () => {
		expect(lineSimilarity('hello world', 'hello world')).toBe(1);
		expect(lineSimilarity('abcdef', 'xyz123')).toBe(0);
	});

	it('is high for near-identical OCR variants', () => {
		expect(lineSimilarity('meeting notes tuesday', 'meting notes tuesday')).toBeGreaterThan(0.8);
	});
});

describe('mergeBandTranscriptions', () => {
	it('returns a single part unchanged', () => {
		expect(mergeBandTranscriptions(['line one\nline two'])).toBe('line one\nline two');
	});

	it('drops the overlap-duplicated lines at the seam', () => {
		const a = 'first line\nsecond line\nthird line';
		const b = 'second line\nthird line\nfourth line';
		expect(mergeBandTranscriptions([a, b])).toBe('first line\nsecond line\nthird line\nfourth line');
	});

	it('dedupes fuzzily when the model reads the seam slightly differently', () => {
		const a = 'shopping list\n- two dozen eggs';
		const b = '- two dozen egqs\n- oat milk';
		expect(mergeBandTranscriptions([a, b])).toBe('shopping list\n- two dozen eggs\n- oat milk');
	});

	it('concatenates when there is no seam overlap', () => {
		expect(mergeBandTranscriptions(['alpha', 'omega'])).toBe('alpha\nomega');
	});

	it('skips EMPTY and blank bands', () => {
		expect(mergeBandTranscriptions(['EMPTY', 'real text', '   ', 'EMPTY.'])).toBe('real text');
		expect(mergeBandTranscriptions(['EMPTY', 'EMPTY'])).toBe('');
	});
});

describe('MAX_VISION_EDGE', () => {
	it('is a sane vision-model resolution', () => {
		expect(MAX_VISION_EDGE).toBeGreaterThanOrEqual(896);
		expect(MAX_VISION_EDGE).toBeLessThanOrEqual(2048);
	});
});
