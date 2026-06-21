import { describe, it, expect, beforeEach } from 'vitest';
import { fetchYouTubeTitle } from '../src/commands/slashCommands';
import { requestUrl } from 'obsidian';

// v0.7-only: fixes clip/summarize_media notes being titled with the URL hostname
// instead of the real video title (fetched via YouTube oEmbed).

const mockRequest = requestUrl as unknown as ReturnType<typeof import('vitest').vi.fn>;
function resp(status: number, json: unknown) {
	return { status, json, text: '', arrayBuffer: new ArrayBuffer(0), headers: {} };
}
beforeEach(() => mockRequest.mockReset());

describe('fetchYouTubeTitle()', () => {
	it('returns the real video title from oEmbed and queries the oEmbed endpoint', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, { title: '  How the petrodollar works  ', author_name: 'X' }));
		const title = await fetchYouTubeTitle('https://www.youtube.com/watch?v=abc123');
		expect(title).toBe('How the petrodollar works'); // trimmed
		const url = (mockRequest.mock.calls[0][0] as { url: string }).url;
		expect(url).toContain('/oembed?url=');
		expect(url).toContain(encodeURIComponent('https://www.youtube.com/watch?v=abc123'));
	});

	it('returns null on a non-200 response (e.g. private/removed video)', async () => {
		mockRequest.mockResolvedValueOnce(resp(401, {}));
		expect(await fetchYouTubeTitle('https://youtu.be/x')).toBeNull();
	});

	it('returns null when oEmbed has no title', async () => {
		mockRequest.mockResolvedValueOnce(resp(200, { author_name: 'X' }));
		expect(await fetchYouTubeTitle('https://youtu.be/x')).toBeNull();
	});

	it('returns null (does not throw) when the request fails', async () => {
		mockRequest.mockRejectedValueOnce(new Error('network down'));
		expect(await fetchYouTubeTitle('https://youtu.be/x')).toBeNull();
	});
});
