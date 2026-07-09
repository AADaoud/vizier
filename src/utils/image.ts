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
