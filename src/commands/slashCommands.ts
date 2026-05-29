import { App, TFile, requestUrl } from 'obsidian';
import { callOllama, callOllamaStructured } from '../utils/ollama';
import { mapReduceSummarize } from '../utils/chunking';
import { Prompts } from '../prompts';
import { ClipLearnModal } from '../ui/ClipLearnModal';
import { sanitizeFilename, sanitizeTag, buildYamlTags, today } from '../utils/noteBuilder';
import { AIAgentSettings } from '../settings';

export interface SlashCommand {
	id: string;
	label: string;
	description: string;
	template: string;
}

export interface CommandConfig {
	ollamaUrl: string;
	serverUrl: string;
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
		description: 'Create a new AI-generated note',
		template: '/write ',
	},
	{
		id: 'edit',
		label: '/edit',
		description: 'Edit the active note with an AI instruction',
		template: '/edit ',
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
		id: 'clip learn',
		label: '/clip learn',
		description: 'Clip a URL, save detailed notes, and generate an interactive study guide',
		template: '/clip learn ',
	},
	{
		id: 'read',
		label: '/read',
		description: 'Summarize or ask a question about the active note',
		template: '/read ',
	},
	{
		id: 'handwriting',
		label: '/handwriting',
		description: 'Paste a handwritten note image — transcribes and saves with AI',
		template: '/handwriting',
	},
	{
		id: 'person',
		label: '/person',
		description: 'Create a person note — searches Wikipedia or manual entry',
		template: '/person ',
	},
	{
		id: 'event',
		label: '/event',
		description: 'Create a historical event note — searches Wikipedia or manual entry',
		template: '/event ',
	},
	{
		id: 'idea',
		label: '/idea',
		description: 'Create a geopolitical concept or theory note',
		template: '/idea ',
	},
	{
		id: 'link',
		label: '/link',
		description: 'Link two entities — e.g. /link Person | Event or /link A | B | relationship',
		template: '/link ',
	},
	{
		id: 'entity',
		label: '/entity',
		description: 'Create a note for any entity type — e.g. /entity organization | NATO',
		template: '/entity ',
	},
	{
		id: 'bridge',
		label: '/bridge',
		description: 'Find the shortest path between two Human Network entities — e.g. /bridge A | B',
		template: '/bridge ',
	},
	{
		id: 'timeline',
		label: '/timeline',
		description: 'Build a chronological timeline — e.g. /timeline Cold War or /timeline 1939..1945',
		template: '/timeline ',
	},
	{
		id: 'standardize',
		label: '/standardize',
		description: 'Add missing metadata to all notes in a folder — e.g. /standardize Clips',
		template: '/standardize ',
	},
	{
		id: 'socratic',
		label: '/socratic',
		description: 'Generate Socratic questions for the active note and capture your answers',
		template: '/socratic',
	},
	{
		id: 'recluster',
		label: '/recluster',
		description: 'Cluster notes in a folder into themes — e.g. /recluster Clips',
		template: '/recluster ',
	},
	{
		id: 'contradict',
		label: '/contradict',
		description: 'Find vault notes that contradict claims in the active note',
		template: '/contradict',
	},
	{
		id: 'sources',
		label: '/sources',
		description: 'Audit the active note for uncited factual claims',
		template: '/sources',
	},
	{
		id: 'thesis',
		label: '/thesis',
		description: 'Build a structured thesis from tagged notes — e.g. /thesis BTC',
		template: '/thesis ',
	},
	{
		id: 'weekly',
		label: '/weekly',
		description: 'Generate a weekly reflection scaffold from notes modified this week',
		template: '/weekly',
	},
	{
		id: 'monthly',
		label: '/monthly',
		description: 'Generate a monthly reflection scaffold from notes modified this month',
		template: '/monthly',
	},
	{
		id: 'freewrite',
		label: '/freewrite',
		description: 'Open a new timestamped blank note for free writing',
		template: '/freewrite',
	},
	{
		id: 'ingest',
		label: '/ingest',
		description: 'Ingest a book or document chapter-by-chapter — e.g. /ingest Books/book.pdf',
		template: '/ingest ',
	},
	{
		id: 'transcribe',
		label: '/transcribe',
		description: 'Transcribe an audio file or podcast URL via Whisper',
		template: '/transcribe ',
	},
];

// --- helpers ---

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

async function fetchAndSummarizeYouTube(url: string, model: string, config: CommandConfig, detailed = false, onStatus?: (msg: string) => void): Promise<string> {
	const videoId = extractYouTubeId(url);
	if (!videoId) throw new Error('Could not parse a YouTube video ID from that URL.');

	let response: Awaited<ReturnType<typeof requestUrl>>;
	try {
		response = await requestUrl({
			url: `${config.serverUrl}/transcript?video_id=${encodeURIComponent(videoId)}`,
			throw: false,
		});
	} catch {
		throw new Error('TRANSCRIPT_SERVER_UNREACHABLE');
	}
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

	return mapReduceSummarize(data.transcript, model, 'YouTube video', config.ollamaUrl, detailed, onStatus);
}

async function fetchAndSummarizeArticle(url: string, model: string, ollamaUrl: string, detailed = false, onStatus?: (msg: string) => void): Promise<string> {
	// Use Jina AI Reader to fetch a clean, reader-friendly version of the page.
	// This handles JavaScript-rendered content, paywalls, and encoding issues far
	// better than fetching raw HTML. No API key required.
	let jinaError: Error | null = null;
	try {
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
		return await mapReduceSummarize(text, model, 'article', ollamaUrl, detailed, onStatus);
	} catch (err) {
		jinaError = err instanceof Error ? err : new Error(String(err));
	}

	// Jina failed — fall back to raw HTML fetch
	onStatus?.('Jina unavailable — fetching raw HTML…');
	const rawRes = await requestUrl({ url, throw: false });
	if (rawRes.status === 0 || rawRes.status >= 400) {
		throw jinaError;
	}
	const stripped = rawRes.text
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const wordCount = stripped.split(/\s+/).filter(w => w.length > 0).length;
	if (stripped.length < 500 || wordCount < 50) throw jinaError;
	return mapReduceSummarize(stripped, model, 'article', ollamaUrl, detailed, onStatus);
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
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	aiNotesFolder = ''
): Promise<void> {
	const topic = args.trim();
	if (!topic) {
		addMessage('assistant', 'Usage: `/write <topic description>`\n\nExample: `/write A note about quantum computing`');
		return;
	}

	addMessage('assistant', 'Generating note…');

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
		replaceMessage('assistant', `Failed to generate note: ${msg}`);
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

	// Always create a new file — find an unused name if needed
	let filePath = `${prefix}${sanitized}.md`;
	for (let i = 2; i <= 10; i++) {
		if (!app.vault.getAbstractFileByPath(filePath)) break;
		filePath = `${prefix}${sanitized}-${i}.md`;
	}

	const tags = [...(result.tags ?? []), 'ai'].map(sanitizeTag).filter(t => t.length > 0);
	const yamlTags = buildYamlTags(tags);
	const fileContent = `---\ntype: write\ncreated: ${today()}\ntags:\n${yamlTags}\n---\n\n${result.body}`;

	replaceMessage('assistant', 'Writing to file…');
	try {
		await app.vault.create(filePath, fileContent);
		const displayName = filePath.replace(/^.*\//, '').replace(/\.md$/, '');
		replaceMessage('assistant', `Created **[[${displayName}]]** at \`${filePath}\`.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to write note: ${msg}`);
	}
}

// --- /edit ---

export async function executeEdit(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig
): Promise<void> {
	const instruction = args.trim();
	if (!instruction) {
		addMessage('assistant', 'Usage: `/edit <instruction>`\n\nExample: `/edit make it more concise`');
		return;
	}
	const file = app.workspace.getActiveFile();
	if (!file) {
		addMessage('assistant', 'No active note. Open a note first, then run `/edit`.');
		return;
	}
	const content = await app.vault.cachedRead(file);
	addMessage('assistant', `Editing **${file.basename}**…`);
	try {
		const edited = await callOllama({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.editNote(instruction, content) }],
		});
		replaceMessage('assistant', 'Writing changes…');
		await app.vault.modify(file, edited);
		replaceMessage('assistant', `Updated **[[${file.basename}]]**.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to edit note: ${msg}`);
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

const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'on', 'in', 'of', 'for', 'to', 'and', 'or', 'vs', 'about', 'with', 'from', 'by', 'at', 'as', 'i', 'my', 'me', 'we', 'it', 'that', 'this']);

function queryToTerms(query: string): string[] {
	const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
	return words.length > 0 ? words : [query.toLowerCase()];
}

export async function executeFind(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	addFindResults: AddFindResults,
	model: string,
	config: CommandConfig
): Promise<void> {
	const query = args.trim();
	if (!query) {
		addMessage('assistant', 'Usage: `/find <query>`\n\nExample: `/find machine learning neural networks`');
		return;
	}

	addMessage('assistant', 'Searching…');

	// Direct terms from query words (always included)
	const directTerms = queryToTerms(query);

	// AI expands with alternative phrasings/abbreviations that would literally appear in notes
	let aiTerms: string[] = [];
	try {
		const result = await callOllamaStructured<FindTermsResult>({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.findQueryTerms(query) }],
			format: FIND_TERMS_SCHEMA,
		});
		aiTerms = result.terms.filter(t => t.trim().length > 0).slice(0, 4);
	} catch { /* use only direct terms */ }

	// Merge: direct terms first, then unique AI terms
	const allTerms = [...new Set([...directTerms, ...aiTerms.map(t => t.toLowerCase())])];

	// Search vault: match terms against note titles/frontmatter first (no I/O),
	// then read each unmatched file at most once across all terms.
	const files = app.vault.getMarkdownFiles();
	const matchMap = new Map<string, Set<string>>(); // path → matched terms

	// Pass 1: basename + frontmatter title — no file reads
	for (const term of allTerms) {
		const lower = term.toLowerCase();
		for (const file of files) {
			if (file.basename.toLowerCase().includes(lower)) {
				if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
				matchMap.get(file.path)!.add(term);
				continue;
			}
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			const fmTitle = ((fm?.['name'] ?? fm?.['title'] ?? '') as string).toLowerCase();
			if (fmTitle && fmTitle.includes(lower)) {
				if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
				matchMap.get(file.path)!.add(term);
			}
		}
	}

	// Pass 2: read each unmatched file ONCE, then test all terms against it
	const unmatched = files.filter(f => !matchMap.has(f.path));
	for (const file of unmatched.slice(0, 300)) {
		let text: string;
		try {
			text = (await app.vault.cachedRead(file)).toLowerCase();
		} catch { continue; }
		for (const term of allTerms) {
			if (text.includes(term.toLowerCase())) {
				if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
				matchMap.get(file.path)!.add(term);
			}
		}
	}

	if (matchMap.size === 0) {
		replaceMessage('assistant', `No notes found for **"${query}"**.`);
		return;
	}

	const pathToBasename = new Map(files.map(f => [f.path, f.basename]));
	const candidates: FindCandidate[] = [...matchMap.entries()].slice(0, 20).map(([path, termSet]) => ({
		title: pathToBasename.get(path) ?? path,
		relevance: '',
		terms: [...termSet],
	}));

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
				'Could not reach the Vizier server.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start Vizier server"** to install dependencies and start it automatically.'
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
	clipsFolder: string,
	settings?: AIAgentSettings,
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

	const onStatus = (msg: string) => replaceMessage('assistant', msg);

	let summary: string;
	try {
		if (isYouTube) {
			replaceMessage('assistant', 'Fetching transcript…');
			summary = await fetchAndSummarizeYouTube(url, model, config, detailed, onStatus);
		} else {
			replaceMessage('assistant', 'Fetching page…');
			summary = await fetchAndSummarizeArticle(url, model, config.ollamaUrl, detailed, onStatus);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isYouTube && msg.includes('TRANSCRIPT_SERVER_UNREACHABLE')) {
			replaceMessage(
				'assistant',
				'Could not reach the Vizier server.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start Vizier server"** to install dependencies and start it automatically.'
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

	const date = today();
	const safeTitle = sanitizeFilename(meta.title);
	const filename = `${date} - ${safeTitle}`;
	const yamlTags = buildYamlTags(['clip', ...meta.tags]);
	const noteContent = `---\ntype: clip\nsource: "${url}"\ncreated: ${date}\ntags:\n${yamlTags}\n---\n\n${summary}`;

	replaceMessage('assistant', 'Writing to file…');
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

		// Entity extraction (async, non-blocking for the user message already shown)
		if (settings) {
			try {
				const { runEntityExtraction } = await import('./entityExtraction');
				await runEntityExtraction(summary, filePath, app, addMessage, model, config, settings);
			} catch { /* entity extraction is best-effort */ }
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to save note: ${msg}`);
	}
}

// --- /clip learn ---

export async function executeClipLearn(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	clipsFolder: string,
	settings?: AIAgentSettings,
): Promise<void> {
	const url = args.trim();
	if (!url || !/^https?:\/\//.test(url) || !isLikelyValidUrl(url)) {
		addMessage('assistant', 'Usage: `/clip learn <url>` — fetches, saves detailed notes, and generates a study guide to reinforce learning.');
		return;
	}

	const isYouTube = /youtube\.com|youtu\.be/.test(url);
	addMessage('assistant', 'Fetching content…');

	const onStatus = (msg: string) => replaceMessage('assistant', msg);

	let summary: string;
	try {
		if (isYouTube) {
			replaceMessage('assistant', 'Fetching transcript…');
			summary = await fetchAndSummarizeYouTube(url, model, config, true, onStatus);
		} else {
			replaceMessage('assistant', 'Fetching page…');
			summary = await fetchAndSummarizeArticle(url, model, config.ollamaUrl, true, onStatus);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isYouTube && msg.includes('TRANSCRIPT_SERVER_UNREACHABLE')) {
			replaceMessage(
				'assistant',
				'Could not reach the Vizier server.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start Vizier server"** to install dependencies and start it automatically.'
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

	const date = today();
	const safeTitle = sanitizeFilename(meta.title);
	const filename = `${date} - ${safeTitle}`;
	const yamlTags = buildYamlTags(['clip', 'learn', ...meta.tags]);
	const noteContent = `---\ntype: clip\nsource: "${url}"\ncreated: ${date}\ntags:\n${yamlTags}\n---\n\n${summary}`;

	replaceMessage('assistant', 'Writing to file…');
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
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to save note: ${msg}`);
		return;
	}

	// Entity extraction (non-blocking)
	if (settings) {
		try {
			const { runEntityExtraction } = await import('./entityExtraction');
			await runEntityExtraction(summary, `${clipsFolder}/${filename}.md`, app, addMessage, model, config, settings);
		} catch { /* best-effort */ }
	}

	replaceMessage('assistant', 'Generating study guide…');
	let studyGuide: string;
	try {
		studyGuide = await callOllama({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.learnStudyGuide(summary) }],
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Saved to **[[${filename}]]** — but failed to generate study guide: ${msg}`);
		return;
	}

	// Build a compact chat message: overview + concept terms + takeaways
	const sections = parseStudyGuideSections(studyGuide);
	const chatParts: string[] = [];
	if (sections.overview) chatParts.push(sections.overview);
	if (sections.keyConcepts.length > 0) {
		chatParts.push(`\n**Key Concepts:** ${sections.keyConcepts.map(c => c.term).join(' · ')}`);
	}
	if (sections.takeaways.length > 0) {
		chatParts.push(`\n**Takeaways:**\n${sections.takeaways.map(t => `- ${t}`).join('\n')}`);
	}
	if (sections.reviewQA.length > 0) {
		chatParts.push(`\n*Study guide and review questions are open in a panel.*`);
	}

	replaceMessage('assistant', chatParts.join('\n'));
	addMessage('assistant', `Saved to **[[${filename}]]**`);

	new ClipLearnModal(app, meta.title, studyGuide).open();
}

function parseStudyGuideSections(content: string): {
	overview: string;
	keyConcepts: Array<{ term: string }>;
	takeaways: string[];
	reviewQA: Array<{ question: string; answer: string }>;
} {
	const result = { overview: '', keyConcepts: [] as Array<{ term: string }>, takeaways: [] as string[], reviewQA: [] as Array<{ question: string; answer: string }> };
	const parts = content.split(/^##\s+/m).filter(p => p.trim());
	for (const part of parts) {
		const newline = part.indexOf('\n');
		if (newline === -1) continue;
		const heading = part.slice(0, newline).trim().toLowerCase();
		const body = part.slice(newline + 1).trim();
		if (heading.includes('overview')) {
			result.overview = body.replace(/\n+/g, ' ').trim();
		} else if (heading.includes('key concept')) {
			for (const line of body.split('\n')) {
				const match = line.match(/^\*\*(.+?)\*\*/);
				if (match && match[1]) result.keyConcepts.push({ term: match[1].trim() });
			}
		} else if (heading.includes('takeaway')) {
			for (const line of body.split('\n')) {
				const stripped = line.replace(/^[-*]\s+/, '').trim();
				if (stripped) result.takeaways.push(stripped);
			}
		} else if (heading.includes('review') || heading.includes('question')) {
			for (const line of body.split('\n')) {
				const trimmed = line.trim();
				const sepIdx = trimmed.indexOf(' // ');
				if (sepIdx === -1) continue;
				const q = trimmed.slice(0, sepIdx).replace(/^Q:\s*/i, '').trim();
				const a = trimmed.slice(sepIdx + 4).replace(/^A:\s*/i, '').trim();
				if (q && a) result.reviewQA.push({ question: q, answer: a });
			}
		}
	}
	return result;
}

// --- /read ---

export async function executeRead(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
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
		replaceMessage('assistant', summary);
	} else {
		addMessage('assistant', `Reading **${file.basename}**…`);
		const answer = await callOllama({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.readQuestion(question, content) }],
		});
		replaceMessage('assistant', answer);
	}
}

// --- /handwriting ---

function getAttachmentFolder(app: App): string {
	try {
		const cfg = (app.vault as unknown as { getConfig: (key: string) => string }).getConfig('attachmentFolderPath');
		if (cfg && cfg !== '/' && !cfg.startsWith('./')) return cfg;
	} catch { /* */ }
	return 'Attachments';
}

export async function executeHandwriting(
	imageFile: File,
	app: App,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	notesFolder: string,
): Promise<void> {
	// 1. Read image as base64
	replaceMessage('assistant', 'Reading image…');
	const buffer = await imageFile.arrayBuffer();
	const uint8 = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i] ?? 0);
	const base64 = btoa(binary);

	// 2. Run OCR via dedicated server
	replaceMessage('assistant', 'Transcribing handwriting…');
	let transcriptionText = '';

	let ocrRes: Awaited<ReturnType<typeof requestUrl>>;
	try {
		ocrRes = await requestUrl({
			url: `${config.serverUrl}/ocr`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: base64 }),
			throw: false,
		});
	} catch {
		ocrRes = { status: 0 } as never;
	}

	if (ocrRes.status === 0) {
		replaceMessage('assistant',
			'The Vizier server is not running.\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start Vizier server"** to install dependencies and start it automatically.');
		return;
	}

	if (ocrRes.status === 503) {
		const errData = ocrRes.json as { error?: string };
		replaceMessage('assistant',
			`OCR dependencies not installed.\n\n${errData.error ?? ''}\n\nOpen the **Command Palette** (Ctrl/Cmd+P) and run **"Vizier: Setup / start Vizier server"** to install them.`);
		return;
	}

	if (ocrRes.status !== 200) {
		const errData = ocrRes.json as { error?: string };
		replaceMessage('assistant', `OCR server error: ${errData.error ?? `HTTP ${ocrRes.status}`}`);
		return;
	}

	const ocrData = ocrRes.json as { text: string };
	transcriptionText = ocrData.text ?? '';

	if (!transcriptionText.trim()) {
		replaceMessage('assistant', 'OCR returned no text. Check the image is clear and contains handwriting.');
		return;
	}

	// 3. Vision-assisted reconstruction (non-fatal, falls back to raw OCR)
	try {
		replaceMessage('assistant', 'Reconstructing with vision model…');
		const visionResult = await callOllama({
			ollamaUrl: config.ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.handwritingReconstruct(transcriptionText), images: [base64] }],
		});
		if (visionResult.trim()) {
			transcriptionText = visionResult;
		}
	} catch {
		// vision pass failed — keep raw OCR text
	}

	// 4. Save image to vault attachment folder
	replaceMessage('assistant', 'Saving image…');
	const attachmentFolder = getAttachmentFolder(app);
	const timestamp = Date.now();
	const ext = imageFile.name.includes('.') ? (imageFile.name.split('.').pop() ?? 'png') : 'png';
	const imgFilename = `handwriting-${timestamp}.${ext}`;
	const imgPath = attachmentFolder ? `${attachmentFolder}/${imgFilename}` : imgFilename;

	try {
		const folderExists = attachmentFolder && app.vault.getAbstractFileByPath(attachmentFolder);
		if (attachmentFolder && !folderExists) await app.vault.createFolder(attachmentFolder);
		await app.vault.createBinary(imgPath, buffer);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to save image: ${msg}`);
		return;
	}

	// 5. Create note with embedded image and transcription callout
	replaceMessage('assistant', 'Creating note…');
	const date = today();
	const noteBaseName = `${date} - Handwritten Note`;
	const transcriptionLines = transcriptionText.split('\n').map(l => `> ${l}`).join('\n');
	const noteContent = `---\ntype: handwriting\ncreated: ${date}\ntags:\n  - handwriting\n---\n\n![[${imgFilename}]]\n\n> [!note] Transcription\n${transcriptionLines}\n`;

	const baseNotePath = `${notesFolder}/${noteBaseName}.md`;
	const noteFilePath = app.vault.getAbstractFileByPath(baseNotePath)
		? `${notesFolder}/${noteBaseName} ${timestamp}.md`
		: baseNotePath;
	const noteFilename = noteFilePath.replace(/\.md$/, '').split('/').pop() ?? noteBaseName;

	try {
		const notesFolderExists = app.vault.getAbstractFileByPath(notesFolder);
		if (!notesFolderExists) await app.vault.createFolder(notesFolder);
		await app.vault.create(noteFilePath, noteContent);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Image saved but failed to create note: ${msg}`);
		return;
	}

	replaceMessage('assistant', `Saved to **[[${noteFilename}]]**\n\n> [!note] Transcription\n${transcriptionLines}`);
}
