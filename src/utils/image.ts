/**
 * image.ts — client-side image preparation for vision-model calls.
 *
 * Vision models effectively see at most ~1–2 MP; sending a 12 MP phone photo
 * just wastes encode/transfer/inference time. Everything sent to a model goes
 * through prepareImageForVision: decode → downscale → JPEG re-encode → base64.
 */

/** Longest edge sent to vision models. */
export const MAX_VISION_EDGE = 1280;

const JPEG_QUALITY = 0.85;

/**
 * Base64-encode an ArrayBuffer in 32 KB chunks. A per-byte
 * `binary += String.fromCharCode(b)` loop is O(n²) on string reallocation and
 * takes seconds on a multi-MB photo; chunked spread + join is near-linear.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const CHUNK = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
	}
	return btoa(parts.join(''));
}

/** Scale (width, height) down so the longest edge is at most maxEdge. Never upscales. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (longest <= maxEdge || longest === 0) return { width, height };
	const scale = maxEdge / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

// ── Band segmentation ──────────────────────────────────────────────────────
// A full notebook page downscaled to MAX_VISION_EDGE leaves each line of
// handwriting ~15 px tall — too small for reliable transcription. Tall pages
// are instead cut into overlapping horizontal bands, each rendered near full
// width, so every line reaches the model at readable resolution. The overlap
// guarantees no line is cut in half; the duplicated lines are removed when
// the per-band transcriptions are merged.

/** Target band height as a fraction of image width (band ≈ 1280×768 after scaling). */
const BAND_ASPECT = 0.6;
/** Fraction of a band's height shared with the next band. */
const BAND_OVERLAP = 0.15;
/** Hard cap on bands per image (latency grows linearly with band count). */
const MAX_BANDS = 6;

export interface BandPlan {
	/** Source-space crop rects, top to bottom. A single entry means "don't slice". */
	bands: { y: number; height: number }[];
	/** Scale (≤ 1) applied when rendering each band. */
	scale: number;
}

/** Decide how to slice an image of the given source dimensions into bands. */
export function planBands(width: number, height: number, maxEdge = MAX_VISION_EDGE): BandPlan {
	const whole: BandPlan = {
		bands: [{ y: 0, height }],
		scale: Math.min(1, maxEdge / Math.max(width, height, 1)),
	};
	if (width <= 0 || height <= 0) return whole;

	let bandH = Math.round(width * BAND_ASPECT);
	let overlap = Math.round(bandH * BAND_OVERLAP);
	if (bandH >= height || bandH <= overlap) return whole;

	let n = Math.ceil((height - overlap) / (bandH - overlap));
	if (n <= 1) return whole;
	if (n > MAX_BANDS) {
		// Too tall for the cap — grow the bands so MAX_BANDS still cover the page.
		n = MAX_BANDS;
		bandH = Math.ceil((height + (n - 1) * overlap) / n);
		overlap = Math.round(bandH * BAND_OVERLAP);
	}

	const step = (height - bandH) / (n - 1);
	const bands: { y: number; height: number }[] = [];
	for (let i = 0; i < n; i++) {
		const y = Math.min(Math.round(i * step), height - 1);
		bands.push({ y, height: Math.min(bandH, height - y) });
	}
	return { bands, scale: Math.min(1, maxEdge / width) };
}

export interface PreparedImage {
	/** Base64 payload to send to the model (no data: prefix). */
	base64: string;
	/** True when the payload is a downscaled/re-encoded JPEG rather than the original bytes. */
	reencoded: boolean;
}

/**
 * Prepare image bytes for a vision-model call: downscale to MAX_VISION_EDGE
 * and re-encode as JPEG. Transparent regions are flattened onto white (JPEG
 * has no alpha; without this they render black). Falls back to the original
 * bytes when the image can't be decoded (exotic format) or when re-encoding
 * wouldn't shrink the payload.
 */
export async function prepareImageForVision(buffer: ArrayBuffer, mime: string): Promise<PreparedImage> {
	try {
		const blob = new Blob([buffer], { type: mime || 'image/png' });
		const bitmap = await createImageBitmap(blob);
		try {
			const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_VISION_EDGE);
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const cx = canvas.getContext('2d');
			if (!cx) throw new Error('no 2d context');
			cx.fillStyle = '#ffffff';
			cx.fillRect(0, 0, width, height);
			cx.drawImage(bitmap, 0, 0, width, height);
			const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
			const jpeg = dataUrl.slice(dataUrl.indexOf(',') + 1);

			if (width !== bitmap.width || height !== bitmap.height) {
				return { base64: jpeg, reencoded: true };
			}
			// Not downscaled — keep whichever encoding is smaller (a small
			// source JPEG can be smaller than our re-encode of it).
			const original = arrayBufferToBase64(buffer);
			return jpeg.length < original.length
				? { base64: jpeg, reencoded: true }
				: { base64: original, reencoded: false };
		} finally {
			bitmap.close();
		}
	} catch {
		return { base64: arrayBufferToBase64(buffer), reencoded: false };
	}
}

export interface PreparedBands {
	/** One base64 JPEG per band, top to bottom (single entry when not sliced). */
	bands: string[];
	/** True when the image was actually sliced into multiple bands. */
	banded: boolean;
}

/**
 * Prepare an image as one or more transcription-ready bands. Short images pass
 * through prepareImageForVision unchanged; tall pages are sliced per planBands.
 * Falls back to the raw bytes as a single "band" when decoding fails.
 */
export async function prepareImageBands(buffer: ArrayBuffer, mime: string): Promise<PreparedBands> {
	try {
		const blob = new Blob([buffer], { type: mime || 'image/png' });
		const bitmap = await createImageBitmap(blob);
		try {
			const plan = planBands(bitmap.width, bitmap.height);
			if (plan.bands.length <= 1) {
				const single = await prepareImageForVision(buffer, mime);
				return { bands: [single.base64], banded: false };
			}
			const outW = Math.max(1, Math.round(bitmap.width * plan.scale));
			const bands: string[] = [];
			for (const band of plan.bands) {
				const outH = Math.max(1, Math.round(band.height * plan.scale));
				const canvas = document.createElement('canvas');
				canvas.width = outW;
				canvas.height = outH;
				const cx = canvas.getContext('2d');
				if (!cx) throw new Error('no 2d context');
				cx.fillStyle = '#ffffff';
				cx.fillRect(0, 0, outW, outH);
				cx.drawImage(bitmap, 0, band.y, bitmap.width, band.height, 0, 0, outW, outH);
				const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
				bands.push(dataUrl.slice(dataUrl.indexOf(',') + 1));
			}
			return { bands, banded: true };
		} finally {
			bitmap.close();
		}
	} catch {
		return { bands: [arrayBufferToBase64(buffer)], banded: false };
	}
}
