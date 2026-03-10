import { App, TFile, requestUrl } from 'obsidian';
import { callOllama, callOllamaStructured } from '../utils/ollama';
import { mapReduceSummarize } from '../utils/chunking';
import { Prompts } from '../prompts';

export interface SlashCommand {
	id: string;
	label: string;
	description: string;
	template: string;
}

export interface CommandConfig {
	ollamaUrl: string;
	transcriptServerUrl: string;
}

export type AddMessage = (role: 'user' | 'assistant', content: string) => void;
export type ReplaceMessage = (role: 'user' | 'assistant', content: string) => void;

export interface FindCandidate {
	title: string;
	relevance: string;
	terms: string[];
}

export type AddFindResults = (query: string, candidates: FindCandidate[]) => void;

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
		description: 'Find notes using natural language',
		template: '/find ',
	},
	{
		id: 'summarize',
		label: '/summarize',
		description: 'Summarize a YouTube video or article from a URL',
		template: '/summarize ',
	},
	{
		id: 'clip',
		label: '/clip',
		description: 'Fetch a URL, summarize it, and save to your Clips folder',
		template: '/clip ',
	},
	{
		id: 'clip long',
		label: '/clip long',
		description: 'Clip and save detailed notes — ideal for lectures or classes',
		template: '/clip long ',
	},
	{
		id: 'read',
		label: '/read',
		description: 'Summarize or ask a question about the active note',
		template: '/read ',
	},
];

// --- helpers ---

function sanitizeFilename(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').replace(/-{2,}/g, '-').trim();
	return cleaned || 'untitled';
}

function sanitizeTag(tag: string): string {
	const cleaned = tag
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9\-_]/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
	return cleaned || '';
}

function buildYamlTags(tags: string[]): string {
	return tags
		.map(t => sanitizeTag(t))
		.filter(t => t.length > 0)
		.filter((t, i, arr) => arr.indexOf(t) === i)
		.map(t => `  - ${t}`)
		.join('\n');
}


function isLikelyValidUrl(url: string): boolean {
	try {
		const { hostname } = new URL(url);
		const parts = hostname.split('.');
		const tld = parts[parts.length - 1] ?? '';
		return parts.length >= 2 && tld.length >= 2;
	} catch { return false; }
}

function extractYouTubeId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v');
		if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
	} catch { /* invalid URL */ }
	return null;
}

async function fetchAndSummarizeYouTube(url: string, model: string, config: CommandConfig, detailed = false): Promise<string> {
	const videoId = extractYouTubeId(url);
	if (!videoId) throw new Error('Could not parse a YouTube video ID from that URL.');

	const response = await requestUrl({
		url: `${config.transcriptServerUrl}/transcript?video_id=${encodeURIComponent(videoId)}`,
		throw: false,
	});
	if (response.status === 0) {
		throw new Error('TRANSCRIPT_SERVER_UNREACHABLE');
	}
	const data = response.json as { transcript?: string; error?: string };
	if (response.status >= 400) {
		throw new Error(data.error ?? `Transcript server returned HTTP ${response.status}.`);
	}
	if (!data.transcript || data.transcript.trim().length < 100) {
		throw new Error('No usable transcript available for this video.');
	}

	return mapReduceSummarize(data.transcript, model, 'YouTube video', config.ollamaUrl, detailed);
}

async function fetchAndSummarizeArticle(url: string, model: string, ollamaUrl: string, detailed = false): Promise<string> {
	// Use Jina AI Reader to fetch a clean, reader-friendly version of the page.
	// This handles JavaScript-rendered content, paywalls, and encoding issues far
	// better than fetching raw HTML. No API key required.
	const jinaUrl = `https://r.jina.ai/${url}`;
	const response = await requestUrl({
		url: jinaUrl,
		headers: {
			'Accept': 'text/plain',
			'X-Return-Format': 'markdown',
		},
		throw: false,
	});
	if (response.status === 429) throw new Error('Jina rate limit reached (20 requests/minute). Wait a moment and try again.');
	if (response.status >= 400) throw new Error(`Could not retrieve article (HTTP ${response.status}). The page may be blocked or unavailable.`);
	const text = response.text.trim();
	const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
	if (text.length < 500 || wordCount < 50) {
		throw new Error('Could not extract readable content from that URL. The page may be a redirect, require authentication, or have no readable text.');
	}
	return mapReduceSummarize(text, model, 'article', ollamaUrl, detailed);
}

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

export async function executeWrite(
	args: string,
	app: App,
	addMessage: AddMessage,
	model: string,
	config: CommandConfig,
	aiNotesFolder = ''
): Promise<void> {
	const topic = args.trim();
	if (!topic) {
		addMessage('assistant', 'Usage: `/write <topic description>`\n\nExample: `/write A note about quantum computing`');
		return;
	}

	let result: NoteStructure;
	try {
		result = await callOllamaStructured<NoteStructure>({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.writeNote(topic) }],
			format: NOTE_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		addMessage('assistant', `Failed to generate note: ${msg}`);
		return;
	}

	const sanitized = sanitizeFilename(result.filename);
	let folderPath: string;
	if (aiNotesFolder) {
		folderPath = aiNotesFolder;
		const folderExists = app.vault.getAbstractFileByPath(aiNotesFolder);
		if (!folderExists) {
			await app.vault.createFolder(aiNotesFolder);
		}
	} else {
		folderPath = app.fileManager.getNewFileParent('').path;
	}
	const prefix = folderPath === '/' || folderPath === '' ? '' : `${folderPath}/`;
	const filePath = `${prefix}${sanitized}.md`;

	const yamlTags = buildYamlTags(result.tags);
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

interface FindTermsResult {
	terms: string[];
}

const FIND_TERMS_SCHEMA = {
	type: 'object',
	properties: {
		terms: { type: 'array', items: { type: 'string' } },
	},
	required: ['terms'],
};

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
	addFindResults: AddFindResults,
	model: string,
	config: CommandConfig
): Promise<void> {
	const query = args.trim();
	if (!query) {
		addMessage('assistant', 'Usage: `/find <natural language query>`\n\nExample: `/find notes about machine learning and neural networks`');
		return;
	}

	addMessage('assistant', 'Generating search terms…');

	// Step 1: use AI to generate search terms from natural language
	let terms: string[] = [];
	try {
		const result = await callOllamaStructured<FindTermsResult>({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.findQueryTerms(query) }],
			format: FIND_TERMS_SCHEMA,
		});
		terms = result.terms.filter(t => t.trim().length > 0).slice(0, 6);
	} catch {
		// fall back to the raw query as a single term
		terms = [query];
	}

	if (terms.length === 0) terms = [query];

	// Step 2: search vault with all terms
	const files = app.vault.getMarkdownFiles();
	const matchMap = new Map<string, Set<string>>(); // title → matched terms

	for (const term of terms) {
		const lower = term.toLowerCase();
		for (const file of files) {
			if (file.basename.toLowerCase().includes(lower)) {
				if (!matchMap.has(file.basename)) matchMap.set(file.basename, new Set());
				matchMap.get(file.basename)!.add(term);
			}
		}
		const unmatched = files.filter(f => !matchMap.has(f.basename));
		for (const file of unmatched.slice(0, 300)) {
			try {
				const text = await app.vault.cachedRead(file);
				if (text.toLowerCase().includes(lower)) {
					if (!matchMap.has(file.basename)) matchMap.set(file.basename, new Set());
					matchMap.get(file.basename)!.add(term);
				}
			} catch { /* skip */ }
		}
	}

	if (matchMap.size === 0) {
		addMessage('assistant', `No notes found for **"${query}"**.\n\nSearch terms tried: ${terms.map(t => `\`${t}\``).join(', ')}`);
		return;
	}

	// Step 3: get relevance blurbs from AI
	const titleList = [...matchMap.keys()].slice(0, 20);
	const context = titleList.map(t => `- ${t}`).join('\n');

	let rankedMatches: Array<{ title: string; relevance: string }> = titleList.map(t => ({ title: t, relevance: '' }));
	try {
		const ranked = await callOllamaStructured<FindResult>({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.findRankResults(query, context) }],
			format: FIND_SCHEMA,
		});
		rankedMatches = ranked.matches;
	} catch { /* use blank relevance */ }

	const candidates: FindCandidate[] = rankedMatches.map(m => ({
		title: m.title,
		relevance: m.relevance,
		terms: [...(matchMap.get(m.title) ?? new Set())],
	}));

	// Replace the "Generating search terms…" message with the interactive results
	addFindResults(query, candidates);
}

// --- /summarize ---

export async function executeSummarize(
	args: string,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig
): Promise<void> {
	const url = args.trim();
	if (!url || !/^https?:\/\//.test(url) || !isLikelyValidUrl(url)) {
		addMessage('assistant', 'Usage: `/summarize <url>` — provide a YouTube or article URL.\n\nExample: `/summarize https://example.com/article`');
		return;
	}

	const isYouTube = /youtube\.com|youtu\.be/.test(url);
	addMessage('assistant', `Fetching content from ${url}…`);

	try {
		let summary: string;
		if (isYouTube) {
			replaceMessage('assistant', 'Fetching transcript…');
			summary = await fetchAndSummarizeYouTube(url, model, config);
		} else {
			replaceMessage('assistant', 'Fetching page…');
			summary = await fetchAndSummarizeArticle(url, model, config.ollamaUrl);
		}
		replaceMessage('assistant', summary);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isYouTube && msg.includes('TRANSCRIPT_SERVER_UNREACHABLE')) {
			replaceMessage(
				'assistant',
				'Could not reach the transcript server.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start transcript server"** to install dependencies and start it automatically.'
			);
		} else {
			replaceMessage('assistant', `Failed to summarize: ${msg}`);
		}
	}
}

// --- /clip ---

interface ClipMetadata {
	title: string;
	tags: string[];
}

const CLIP_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['title', 'tags'],
};

export async function executeClip(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	clipsFolder: string
): Promise<void> {
	const detailed = args.startsWith('long ');
	const url = (detailed ? args.slice(5) : args).trim();
	if (!url || !/^https?:\/\//.test(url) || !isLikelyValidUrl(url)) {
		addMessage('assistant', 'Usage: `/clip <url>` or `/clip long <url>` — fetches, summarizes, and saves to your Clips folder.\n\nUse `/clip long` for detailed lecture or class notes.');
		return;
	}

	const isYouTube = /youtube\.com|youtu\.be/.test(url);
	const modeLabel = detailed ? 'detailed notes' : 'summary';
	addMessage('assistant', `Fetching ${modeLabel}…`);

	let summary: string;
	try {
		if (isYouTube) {
			replaceMessage('assistant', 'Fetching transcript…');
			summary = await fetchAndSummarizeYouTube(url, model, config, detailed);
		} else {
			replaceMessage('assistant', 'Fetching page…');
			summary = await fetchAndSummarizeArticle(url, model, config.ollamaUrl, detailed);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isYouTube && msg.includes('TRANSCRIPT_SERVER_UNREACHABLE')) {
			replaceMessage(
				'assistant',
				'Could not reach the transcript server.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start transcript server"** to install dependencies and start it automatically.'
			);
		} else {
			replaceMessage('assistant', `Failed to fetch: ${msg}`);
		}
		return;
	}

	replaceMessage('assistant', 'Extracting metadata…');
	let meta: ClipMetadata;
	try {
		meta = await callOllamaStructured<ClipMetadata>({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.clipMetadata(summary) }],
			format: CLIP_SCHEMA,
		});
	} catch {
		meta = { title: new URL(url).hostname, tags: ['clip'] };
	}

	const date = new Date().toISOString().slice(0, 10);
	const safeTitle = sanitizeFilename(meta.title);
	const filename = `${date} - ${safeTitle}`;
	const yamlTags = buildYamlTags(['clip', ...meta.tags]);
	const noteContent = `---\nsource: "${url}"\ndate: ${date}\ntags:\n${yamlTags}\n---\n\n${summary}`;

	replaceMessage('assistant', 'Saving…');
	try {
		const folderExists = app.vault.getAbstractFileByPath(clipsFolder);
		if (!folderExists) {
			await app.vault.createFolder(clipsFolder);
		}
		const filePath = `${clipsFolder}/${filename}.md`;
		const existing = app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await app.vault.modify(existing, noteContent);
		} else {
			await app.vault.create(filePath, noteContent);
		}
		replaceMessage('assistant', `Saved to **[[${filename}]]**`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to save note: ${msg}`);
	}
}

// --- /read ---

export async function executeRead(
	args: string,
	app: App,
	addMessage: AddMessage,
	model: string,
	config: CommandConfig
): Promise<void> {
	const file = app.workspace.getActiveFile();
	if (!file) {
		addMessage('assistant', 'No active note. Open a note in the editor first, then run `/read`.');
		return;
	}

	const content = await app.vault.cachedRead(file);
	if (!content || content.trim().length < 10) {
		addMessage('assistant', `The active note **${file.basename}** appears to be empty.`);
		return;
	}

	const question = args.trim();
	if (!question) {
		addMessage('assistant', `Summarizing **${file.basename}**…`);
		const summary = await mapReduceSummarize(content, model, `note "${file.basename}"`, config.ollamaUrl);
		addMessage('assistant', summary);
	} else {
		addMessage('assistant', `Reading **${file.basename}**…`);
		const answer = await callOllama({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.readQuestion(question, content) }],
		});
		addMessage('assistant', answer);
	}
}
