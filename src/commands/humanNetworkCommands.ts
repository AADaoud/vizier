import { App, requestUrl } from 'obsidian';
import { callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { AIAgentSettings } from '../settings';
import { CommandConfig, AddMessage } from './slashCommands';
import {
	PersonNote, EventNote, IdeaNote,
	WikiSearchResult, WikiPageData,
	ManualPersonData, ManualEventData,
	PersonStructured, EventStructured, IdeaStructured,
} from '../types/humanNetwork';
import { showWikiSearchModal } from '../ui/WikiSearchModal';
import { promptManualPerson, promptManualEvent } from '../ui/ManualEntryModal';
import { promptModal } from '../ui/PromptModal';
import { showImagePickerModal } from '../ui/ImagePickerModal';

// ── Ollama JSON schemas ────────────────────────────────────────────────────

const PERSON_SCHEMA = {
	type: 'object',
	properties: {
		born: { type: 'string' },
		died: { type: 'string' },
		nationality: { type: 'array', items: { type: 'string' } },
		roles: { type: 'array', items: { type: 'string' } },
		bio: { type: 'string' },
		related_people: { type: 'array', items: { type: 'string' } },
		related_events: { type: 'array', items: { type: 'string' } },
		related_ideas: { type: 'array', items: { type: 'string' } },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['born', 'died', 'nationality', 'roles', 'bio', 'related_people', 'related_events', 'related_ideas', 'tags'],
};

const EVENT_SCHEMA = {
	type: 'object',
	properties: {
		date: { type: 'string' },
		date_end: { type: 'string' },
		location: { type: 'string' },
		participants: { type: 'array', items: { type: 'string' } },
		timeline_tags: { type: 'array', items: { type: 'string' } },
		significance: { type: 'string', enum: ['low', 'medium', 'high', ''] },
		related_events: { type: 'array', items: { type: 'string' } },
		related_people: { type: 'array', items: { type: 'string' } },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['date', 'date_end', 'location', 'participants', 'timeline_tags', 'significance', 'related_events', 'related_people', 'tags'],
};

const IDEA_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		domain: { type: 'array', items: { type: 'string' } },
		proponents: { type: 'array', items: { type: 'string' } },
		period: { type: 'string' },
		related_ideas: { type: 'array', items: { type: 'string' } },
		bio: { type: 'string' },
		tags: { type: 'array', items: { type: 'string' } },
	},
	required: ['title', 'domain', 'proponents', 'period', 'related_ideas', 'bio', 'tags'],
};

// ── Helpers ───────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').replace(/-{2,}/g, '-').trim();
	return cleaned || 'untitled';
}

function buildYamlArray(items: string[]): string {
	if (items.length === 0) return '[]';
	return '\n' + items.map(i => `  - "${i.replace(/"/g, '\\"')}"`).join('\n');
}

function buildYamlTagArray(tags: string[]): string {
	if (tags.length === 0) return '[]';
	const clean = tags
		.map(t => t.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''))
		.filter(t => t.length > 0)
		.filter((t, i, arr) => arr.indexOf(t) === i);
	return '\n' + clean.map(t => `  - ${t}`).join('\n');
}

function buildDateField(val: string): string {
	// ISO dates are unquoted for Obsidian Bases date parsing
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(val.trim());
	if (iso) return val.trim();
	return val.trim() ? `"${val.trim()}"` : '""';
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	if (!app.vault.getAbstractFileByPath(folderPath)) {
		await app.vault.createFolder(folderPath);
	}
}

async function deduplicatePath(app: App, base: string, ext = '.md'): Promise<string> {
	let path = `${base}${ext}`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${base}-${n}${ext}`;
		n++;
	}
	return path;
}

async function downloadImage(app: App, imageUrl: string, attachFolder: string): Promise<string> {
	await ensureFolder(app, attachFolder);

	// Derive a clean filename from the URL
	const urlPath = new URL(imageUrl).pathname;
	const raw = decodeURIComponent(urlPath.split('/').pop() ?? 'image.jpg');
	// Strip leading "NNNpx-" thumbnail prefix that Wikimedia adds
	const basename = raw.replace(/^\d+px-/, '');
	const filename = sanitizeFilename(basename);
	const destPath = `${attachFolder}/${filename}`;

	// Skip download if file already exists
	if (app.vault.getAbstractFileByPath(destPath)) return filename;

	const response = await requestUrl({ url: imageUrl, throw: false });
	if (response.status >= 400) return '';

	await app.vault.createBinary(destPath, response.arrayBuffer);
	return filename;
}

const SERVER_OFFLINE_MSG =
	'Vizier server is not running. Use **Vizier: Setup / start Vizier server** from the command palette to start it.';
const WIKI_API_MISSING_MSG =
	'`wikipedia-api` is not installed in the Vizier venv. Restart the server — setup will install it automatically.';

type WikiServerStatus = 'ok' | 'offline' | 'no-wiki-api';

async function checkWikiServer(serverUrl: string): Promise<WikiServerStatus> {
	try {
		const health = await requestUrl({ url: `${serverUrl}/health`, throw: false });
		if (health.status === 0) return 'offline';
	} catch {
		return 'offline';
	}
	// Server is up — probe the search endpoint with an empty query to detect missing library
	try {
		const probe = await requestUrl({
			url: `${serverUrl}/wiki/search?q=test&limit=1`,
			throw: false,
		});
		if (probe.status === 503) return 'no-wiki-api';
	} catch {
		return 'offline';
	}
	return 'ok';
}

async function wikiSearch(serverUrl: string, query: string): Promise<WikiSearchResult[]> {
	const response = await requestUrl({
		url: `${serverUrl}/wiki/search?q=${encodeURIComponent(query)}&limit=8`,
		throw: false,
	});
	if (response.status !== 200) return [];
	const data = response.json as { results?: WikiSearchResult[] };
	return data.results ?? [];
}

async function wikiPage(serverUrl: string, title: string): Promise<WikiPageData | null> {
	const response = await requestUrl({
		url: `${serverUrl}/wiki/page?title=${encodeURIComponent(title)}`,
		throw: false,
	});
	if (response.status !== 200) return null;
	return response.json as WikiPageData;
}

function splitComma(val: string): string[] {
	return val.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// ── Note content builders ─────────────────────────────────────────────────

function buildPersonContent(note: PersonNote): string {
	const imageEmbed = note.image ? `![[${note.image}]]\n\n` : '';
	return [
		'---',
		`type: person`,
		`name: "${note.name.replace(/"/g, '\\"')}"`,
		`born: ${buildDateField(note.born)}`,
		`died: ${buildDateField(note.died)}`,
		`nationality: ${buildYamlArray(note.nationality)}`,
		`roles: ${buildYamlArray(note.roles)}`,
		`wikipedia: "${note.wikipedia}"`,
		`image: "${note.image}"`,
		`related_people: ${buildYamlArray(note.related_people)}`,
		`related_events: ${buildYamlArray(note.related_events)}`,
		`related_ideas: ${buildYamlArray(note.related_ideas)}`,
		`tags: ${buildYamlTagArray(note.tags)}`,
		'---',
		'',
		`${imageEmbed}${note.bio}`,
	].join('\n');
}

function buildEventContent(note: EventNote): string {
	return [
		'---',
		`type: event`,
		`title: "${note.title.replace(/"/g, '\\"')}"`,
		`date: ${buildDateField(note.date)}`,
		`date_end: ${buildDateField(note.date_end)}`,
		`location: "${note.location.replace(/"/g, '\\"')}"`,
		`participants: ${buildYamlArray(note.participants)}`,
		`timeline_tags: ${buildYamlArray(note.timeline_tags)}`,
		`significance: ${note.significance || 'medium'}`,
		`related_events: ${buildYamlArray(note.related_events)}`,
		`related_people: ${buildYamlArray(note.related_people)}`,
		`wikipedia: "${note.wikipedia}"`,
		`tags: ${buildYamlTagArray(note.tags)}`,
		'---',
		'',
	].join('\n');
}

function buildIdeaContent(note: IdeaNote, bio: string): string {
	return [
		'---',
		`type: idea`,
		`title: "${note.title.replace(/"/g, '\\"')}"`,
		`domain: ${buildYamlArray(note.domain)}`,
		`proponents: ${buildYamlArray(note.proponents)}`,
		`period: "${note.period.replace(/"/g, '\\"')}"`,
		`related_ideas: ${buildYamlArray(note.related_ideas)}`,
		`tags: ${buildYamlTagArray(note.tags)}`,
		'---',
		'',
		bio,
	].join('\n');
}

// ── Commands ──────────────────────────────────────────────────────────────

export async function executeCreatePerson(
	name: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	if (!name.trim()) {
		addMessage('assistant', 'Usage: `/person <name>` — e.g. `/person Henry Kissinger`');
		return;
	}

	addMessage('assistant', `Searching Wikipedia for **${name}**…`);

	const serverStatus = await checkWikiServer(config.serverUrl);
	if (serverStatus === 'offline') { replaceMessage('assistant', SERVER_OFFLINE_MSG); return; }
	if (serverStatus === 'no-wiki-api') { replaceMessage('assistant', WIKI_API_MISSING_MSG); return; }

	const results = await wikiSearch(config.serverUrl, name);

	const selection = await showWikiSearchModal(app, results);
	if (!selection) {
		replaceMessage('assistant', 'Cancelled.');
		return;
	}

	let note: PersonNote;

	if ('custom' in selection) {
		const data = await promptManualPerson(app);
		if (!data) {
			replaceMessage('assistant', 'Cancelled.');
			return;
		}
		note = {
			type: 'person',
			name: data.name,
			born: data.born,
			died: data.died,
			nationality: splitComma(data.nationality),
			roles: splitComma(data.roles),
			wikipedia: '',
			image: '',
			bio: data.bio,
			related_people: [],
			related_events: [],
			related_ideas: [],
			tags: ['person'],
		};
	} else {
		replaceMessage('assistant', `Fetching page data for **${selection.title}**…`);
		const pageData = await wikiPage(config.serverUrl, selection.title);
		if (!pageData) {
			replaceMessage('assistant', 'Failed to fetch Wikipedia page data.');
			return;
		}

		replaceMessage('assistant', 'Structuring data with AI…');
		const structured = await callOllamaStructured<PersonStructured>({
			messages: [{ role: 'user', content: Prompts.structurePerson(selection.title, pageData.extract) }],
			model,
			ollamaUrl: config.ollamaUrl,
			format: PERSON_SCHEMA,
		});

		let image = '';
		if (pageData.image_urls.length > 0) {
			const chosenUrl = await showImagePickerModal(app, pageData.image_urls);
			if (chosenUrl) {
				replaceMessage('assistant', 'Downloading image…');
				try {
					image = await downloadImage(app, chosenUrl, 'Attachments');
				} catch {
					// image download is best-effort
				}
			}
		}

		note = {
			type: 'person',
			name: selection.title,
			born: structured.born ?? '',
			died: structured.died ?? '',
			nationality: structured.nationality ?? [],
			roles: structured.roles ?? [],
			wikipedia: pageData.url,
			image,
			bio: structured.bio ?? '',
			related_people: structured.related_people ?? [],
			related_events: structured.related_events ?? [],
			related_ideas: structured.related_ideas ?? [],
			tags: ['person', ...(structured.tags ?? [])],
		};
	}

	await ensureFolder(app, settings.peopleFolder);
	const base = `${settings.peopleFolder}/${sanitizeFilename(note.name)}`;
	const filePath = await deduplicatePath(app, base);
	await app.vault.create(filePath, buildPersonContent(note));

	replaceMessage('assistant', `Created **[[${note.name}]]** in \`${settings.peopleFolder}\``);
}

export async function executeCreateEvent(
	title: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	if (!title.trim()) {
		addMessage('assistant', 'Usage: `/event <title>` — e.g. `/event Cuban Missile Crisis`');
		return;
	}

	addMessage('assistant', `Searching Wikipedia for **${title}**…`);

	const serverStatus = await checkWikiServer(config.serverUrl);
	if (serverStatus === 'offline') { replaceMessage('assistant', SERVER_OFFLINE_MSG); return; }
	if (serverStatus === 'no-wiki-api') { replaceMessage('assistant', WIKI_API_MISSING_MSG); return; }

	const results = await wikiSearch(config.serverUrl, title);

	const selection = await showWikiSearchModal(app, results);
	if (!selection) {
		replaceMessage('assistant', 'Cancelled.');
		return;
	}

	let note: EventNote;

	if ('custom' in selection) {
		const data = await promptManualEvent(app);
		if (!data) {
			replaceMessage('assistant', 'Cancelled.');
			return;
		}
		note = {
			type: 'event',
			title: data.title,
			date: data.date,
			date_end: data.date_end,
			location: data.location,
			participants: splitComma(data.participants),
			timeline_tags: splitComma(data.timeline_tags),
			significance: (['low', 'medium', 'high'].includes(data.significance) ? data.significance : 'medium') as 'low' | 'medium' | 'high',
			related_events: [],
			related_people: [],
			wikipedia: '',
			tags: ['event'],
		};
	} else {
		replaceMessage('assistant', `Fetching page data for **${selection.title}**…`);
		const pageData = await wikiPage(config.serverUrl, selection.title);
		if (!pageData) {
			replaceMessage('assistant', 'Failed to fetch Wikipedia page data.');
			return;
		}

		replaceMessage('assistant', 'Structuring data with AI…');
		const structured = await callOllamaStructured<EventStructured>({
			messages: [{ role: 'user', content: Prompts.structureEvent(selection.title, pageData.extract) }],
			model,
			ollamaUrl: config.ollamaUrl,
			format: EVENT_SCHEMA,
		});

		const validSig = (s: string): 'low' | 'medium' | 'high' | '' =>
			(['low', 'medium', 'high', ''] as const).includes(s as 'low' | 'medium' | 'high' | '') ? s as 'low' | 'medium' | 'high' | '' : '';

		note = {
			type: 'event',
			title: selection.title,
			date: structured.date ?? '',
			date_end: structured.date_end ?? '',
			location: structured.location ?? '',
			participants: structured.participants ?? [],
			timeline_tags: structured.timeline_tags ?? [],
			significance: validSig(structured.significance ?? ''),
			related_events: structured.related_events ?? [],
			related_people: structured.related_people ?? [],
			wikipedia: pageData.url,
			tags: ['event', ...(structured.tags ?? [])],
		};
	}

	await ensureFolder(app, settings.eventsFolder);
	const base = `${settings.eventsFolder}/${sanitizeFilename(note.title)}`;
	const filePath = await deduplicatePath(app, base);
	await app.vault.create(filePath, buildEventContent(note));

	replaceMessage('assistant', `Created **[[${note.title}]]** in \`${settings.eventsFolder}\``);
}

export async function executeCreateIdea(
	concept: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	if (!concept.trim()) {
		addMessage('assistant', 'Usage: `/idea <concept>` — e.g. `/idea Realpolitik`');
		return;
	}

	const description = await promptModal(app, `Idea: ${concept}`, 'Optional: describe this concept in your own words…');

	addMessage('assistant', `Generating idea note for **${concept}**…`);

	const structured = await callOllamaStructured<IdeaStructured>({
		messages: [{ role: 'user', content: Prompts.structureIdea(concept, description ?? '') }],
		model,
		ollamaUrl: config.ollamaUrl,
		format: IDEA_SCHEMA,
	});

	const note: IdeaNote = {
		type: 'idea',
		title: structured.title || concept,
		domain: structured.domain ?? [],
		proponents: structured.proponents ?? [],
		period: structured.period ?? '',
		related_ideas: structured.related_ideas ?? [],
		tags: ['idea', ...(structured.tags ?? [])],
	};

	await ensureFolder(app, settings.ideasFolder);
	const base = `${settings.ideasFolder}/${sanitizeFilename(note.title)}`;
	const filePath = await deduplicatePath(app, base);
	await app.vault.create(filePath, buildIdeaContent(note, structured.bio ?? ''));

	replaceMessage('assistant', `Created **[[${note.title}]]** in \`${settings.ideasFolder}\``);
}

export async function executeLink(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
): Promise<void> {
	const parts = args.split('|').map(s => s.trim());
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		addMessage('assistant', 'Usage: `/link Entity A | Entity B` — e.g. `/link Henry Kissinger | Cuban Missile Crisis`');
		return;
	}

	const [nameA, nameB] = parts as [string, string];
	const files = app.vault.getMarkdownFiles();

	const fileA = files.find(f => f.basename.toLowerCase() === nameA.toLowerCase());
	const fileB = files.find(f => f.basename.toLowerCase() === nameB.toLowerCase());

	if (!fileA || !fileB) {
		const missing: string[] = [];
		if (!fileA) missing.push(nameA);
		if (!fileB) missing.push(nameB);
		addMessage('assistant', `Could not find notes: ${missing.map(n => `**${n}**`).join(', ')}. Create them first with /person, /event, or /idea.`);
		return;
	}

	const contentA = await app.vault.read(fileA);
	const contentB = await app.vault.read(fileB);

	const getType = (content: string): string => {
		const m = content.match(/^type:\s*(\w+)/m);
		return m?.[1] ?? 'unknown';
	};

	const typeA = getType(contentA);
	const typeB = getType(contentB);

	// Determine which relation field to use on each file
	const getRelationField = (ownType: string, otherType: string): string => {
		if (ownType === 'person') {
			if (otherType === 'person') return 'related_people';
			if (otherType === 'event') return 'related_events';
			if (otherType === 'idea') return 'related_ideas';
		}
		if (ownType === 'event') {
			if (otherType === 'person') return 'related_people';
			if (otherType === 'event') return 'related_events';
		}
		if (ownType === 'idea') {
			if (otherType === 'person') return 'proponents';
			if (otherType === 'idea') return 'related_ideas';
		}
		return 'related_people'; // fallback
	};

	const fieldA = getRelationField(typeA, typeB);
	const fieldB = getRelationField(typeB, typeA);

	const appendToField = (content: string, field: string, linkTarget: string): string => {
		const link = `[[${linkTarget}]]`;

		// Check if already linked
		if (content.includes(link)) return content;

		// Try to find the field in frontmatter and append to it
		const fieldRegex = new RegExp(`(^${field}:[^\\n]*(?:\\n  -[^\\n]*)*)`, 'm');
		const match = fieldRegex.exec(content);

		if (match) {
			const insertion = `\n  - "${link}"`;
			return content.slice(0, match.index + match[0].length) + insertion + content.slice(match.index + match[0].length);
		}

		// Field not found — insert it before closing ---
		const closingFm = content.indexOf('\n---', 3);
		if (closingFm !== -1) {
			const newField = `\n${field}:\n  - "${link}"`;
			return content.slice(0, closingFm) + newField + content.slice(closingFm);
		}

		return content;
	};

	const newContentA = appendToField(contentA, fieldA, fileB.basename);
	const newContentB = appendToField(contentB, fieldB, fileA.basename);

	await app.vault.modify(fileA, newContentA);
	await app.vault.modify(fileB, newContentB);

	replaceMessage('assistant', `Linked **[[${fileA.basename}]]** ↔ **[[${fileB.basename}]]**`);
}
