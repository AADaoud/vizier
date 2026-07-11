import { describe, it, expect } from 'vitest';
import { arrayBufferToBase64, fitWithin, prepareImageForVision, MAX_VISION_EDGE } from '../src/utils/image';

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

describe('MAX_VISION_EDGE', () => {
	it('is a sane vision-model resolution', () => {
		expect(MAX_VISION_EDGE).toBeGreaterThanOrEqual(896);
		expect(MAX_VISION_EDGE).toBeLessThanOrEqual(2048);
	});
});
