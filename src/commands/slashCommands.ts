import { App, TFile } from 'obsidian';
import TranscriptClient, { TranscriptResult } from 'youtube-transcript-api';
import { callOllamaStructured } from '../utils/ollama';
import { mapReduceSummarize } from '../utils/chunking';

export interface SlashCommand {
	id: string;
	label: string;
	description: string;
	template: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{
		id: 'write',
		label: '/write',
		description: 'Write content to a new or existing note',
		template: '/write ',
	},
	{
		id: 'find',
		label: '/find',
		description: 'Find notes in your vault by title or content',
		template: '/find ',
	},
	{
		id: 'summarize',
		label: '/summarize',
		description: 'Summarize a YouTube video or article from a URL',
		template: '/summarize ',
	},
];

export type AddMessage = (role: 'user' | 'assistant', content: string) => void;

// --- /write ---

interface NoteStructure {
	filename: string;
	tags: string[];
	body: string;
}

const NOTE_SCHEMA = {
	type: 'object',
	properties: {
		filename: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
		body: { type: 'string' },
	},
	required: ['filename', 'tags', 'body'],
};

function sanitizeFilename(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').replace(/-{2,}/g, '-').trim();
	return cleaned || 'untitled';
}

export async function executeWrite(
	args: string,
	app: App,
	addMessage: AddMessage,
	model: string
): Promise<void> {
	const topic = args.trim();
	if (!topic) {
		addMessage('assistant', 'Usage: `/write <topic description>`\n\nExample: `/write A note about quantum computing`');
		return;
	}

	let result: NoteStructure;
	try {
		result = await callOllamaStructured<NoteStructure>({
			model,
			messages: [
				{
					role: 'user',
					content:
						`Create a well-structured Obsidian markdown note about: ${topic}\n\n` +
						`Provide a descriptive filename (no extension, no path separators), ` +
						`relevant tags as an array, and detailed content for the body field. ` +
						`The body should use markdown headings and be thorough.`,
				},
			],
			format: NOTE_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		addMessage('assistant', `Failed to generate note: ${msg}`);
		return;
	}

	const sanitized = sanitizeFilename(result.filename);
	const folderPath = app.fileManager.getNewFileParent('').path;
	const prefix = folderPath === '/' ? '' : `${folderPath}/`;
	const filePath = `${prefix}${sanitized}.md`;

	const yamlTags = result.tags
		.map(t => `  - ${t.replace(/:/g, '-')}`)
		.join('\n');
	const fileContent = `---\ntags:\n${yamlTags}\n---\n\n${result.body}`;

	try {
		const existing = app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await app.vault.modify(existing, fileContent);
			addMessage('assistant', `Updated **[[${sanitized}]]** at \`${filePath}\`.`);
		} else {
			await app.vault.create(filePath, fileContent);
			addMessage('assistant', `Created **[[${sanitized}]]** at \`${filePath}\`.`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		addMessage('assistant', `Failed to write note: ${msg}`);
	}
}

// --- /find ---

interface FindResult {
	summary: string;
	matches: Array<{ title: string; relevance: string }>;
}

const FIND_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		matches: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					relevance: { type: 'string' },
				},
				required: ['title', 'relevance'],
			},
		},
	},
	required: ['summary', 'matches'],
};

export async function executeFind(
	args: string,
	app: App,
	addMessage: AddMessage,
	model: string
): Promise<void> {
	const query = args.trim();
	if (!query) {
		addMessage('assistant', 'Usage: `/find <query>` — searches note titles and content.\n\nExample: `/find project ideas`');
		return;
	}

	const lower = query.toLowerCase();
	const files = app.vault.getMarkdownFiles();

	const titleMatches: string[] = [];
	const contentMatches: string[] = [];

	for (const file of files) {
		if (file.basename.toLowerCase().includes(lower)) {
			titleMatches.push(file.basename);
		}
	}

	const toSearch = files.filter(f => !titleMatches.includes(f.basename));
	for (const file of toSearch.slice(0, 300)) {
		try {
			const text = await app.vault.cachedRead(file);
			if (text.toLowerCase().includes(lower)) {
				contentMatches.push(file.basename);
			}
		} catch {
			// skip unreadable files
		}
	}

	if (titleMatches.length === 0 && contentMatches.length === 0) {
		addMessage('assistant', `No notes found matching **"${query}"**.`);
		return;
	}

	// Build plain fallback output (used if Ollama fails)
	const fallbackLines: string[] = [];
	if (titleMatches.length > 0) {
		fallbackLines.push(`**Title matches (${titleMatches.length}):**`);
		fallbackLines.push(...titleMatches.slice(0, 15).map(t => `- [[${t}]]`));
	}
	if (contentMatches.length > 0) {
		if (fallbackLines.length > 0) fallbackLines.push('');
		fallbackLines.push(`**Content matches (${contentMatches.length}):**`);
		fallbackLines.push(...contentMatches.slice(0, 15).map(t => `- [[${t}]]`));
	}

	// Build context for Ollama
	const titleSection = titleMatches.length > 0
		? `Title matches:\n${titleMatches.slice(0, 15).map(t => `- ${t}`).join('\n')}`
		: '';
	const contentSection = contentMatches.length > 0
		? `Content matches:\n${contentMatches.slice(0, 15).map(t => `- ${t}`).join('\n')}`
		: '';
	const searchContext = [titleSection, contentSection].filter(Boolean).join('\n\n');

	try {
		const result = await callOllamaStructured<FindResult>({
			model,
			messages: [
				{
					role: 'user',
					content:
						`The user searched their Obsidian vault for: "${query}"\n\n` +
						`Here are the matching notes found:\n${searchContext}\n\n` +
						`Provide a brief summary of what these notes are likely about and a short relevance note for each match.`,
				},
			],
			format: FIND_SCHEMA,
		});

		const matchLines = result.matches
			.map(m => `- [[${m.title}]] — ${m.relevance}`)
			.join('\n');

		addMessage(
			'assistant',
			`**Results for "${query}"**\n\n${result.summary}\n\n**Notes:**\n${matchLines}`
		);
	} catch {
		// Graceful fallback: show raw wikilinks if Ollama is unavailable
		addMessage('assistant', `Found results for **"${query}"**:\n\n${fallbackLines.join('\n')}`);
	}
}

// --- /summarize ---

function extractText(html: string): string {
	let text = html.replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
	text = text.replace(/<\/(p|h[1-6]|li|tr|div|br)>/gi, '\n');
	text = text.replace(/<[^>]+>/g, '');
	text = text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
	return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

function extractYouTubeId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.includes('youtube.com')) {
			return parsed.searchParams.get('v');
		}
		if (parsed.hostname === 'youtu.be') {
			return parsed.pathname.slice(1) || null;
		}
	} catch {
		// invalid URL
	}
	return null;
}

async function summarizeYouTube(
	url: string,
	model: string,
	addMessage: AddMessage
): Promise<void> {
	const videoId = extractYouTubeId(url);
	if (!videoId) {
		addMessage('assistant', 'Could not parse a YouTube video ID from that URL.');
		return;
	}

	let result: TranscriptResult;
	try {
		const client = new TranscriptClient();
		await client.ready;
		result = await client.getTranscript(videoId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === 'invalid video ID') {
			addMessage('assistant', 'Could not find that YouTube video.');
		} else {
			addMessage('assistant', 'Could not reach YouTube. Check your internet connection.');
		}
		return;
	}

	if (
		result.playabilityStatus.status === 'LOGIN_REQUIRED' ||
		result.failedReason === 'PLAYABILITY_STATUS_NOK'
	) {
		addMessage('assistant', 'Could not find that YouTube video.');
		return;
	}

	let text: string;
	const firstTrack = result.tracks.length > 0 ? result.tracks[0] : undefined;

	if (!firstTrack || firstTrack.transcript.length === 0) {
		addMessage('assistant', 'No transcript available for this video. Summarizing from title/description instead.');
		const description = result.microformat?.playerMicroformatRenderer?.description?.simpleText ?? '';
		text = `Title: ${result.title}\n\n${description}`;
	} else {
		text = firstTrack.transcript.map(s => s.text).join(' ');
	}

	const summary = await mapReduceSummarize(text, model, 'YouTube video');
	addMessage('assistant', summary);
}

async function summarizeArticle(
	url: string,
	model: string,
	addMessage: AddMessage
): Promise<void> {
	let html: string;
	try {
		const response = await fetch(url);
		if (!response.ok) {
			addMessage('assistant', `${url} returned HTTP ${response.status}.`);
			return;
		}
		html = await response.text();
	} catch {
		addMessage('assistant', `Could not reach ${url}. Check your internet connection.`);
		return;
	}

	const text = extractText(html);
	if (text.length < 100) {
		addMessage('assistant', 'Could not extract readable text from that URL. The page may require JavaScript or authentication.');
		return;
	}

	const summary = await mapReduceSummarize(text, model, 'article');
	addMessage('assistant', summary);
}

export async function executeSummarize(
	args: string,
	addMessage: AddMessage,
	model: string
): Promise<void> {
	const url = args.trim();
	if (!url || !/^https?:\/\//.test(url)) {
		addMessage('assistant', 'Usage: `/summarize <url>` — provide a YouTube or article URL.\n\nExample: `/summarize https://example.com/article`');
		return;
	}

	addMessage('assistant', `Fetching content from ${url}…`);

	const isYouTube = /youtube\.com|youtu\.be/.test(url);

	try {
		if (isYouTube) {
			await summarizeYouTube(url, model, addMessage);
		} else {
			await summarizeArticle(url, model, addMessage);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		addMessage('assistant', `Failed to summarize: ${msg}`);
	}
}
