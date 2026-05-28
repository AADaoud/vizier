import { App, requestUrl } from 'obsidian';
import { callOllama, callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { AIAgentSettings } from '../settings';
import { CommandConfig, AddMessage } from './slashCommands';
import { findEntityByName, getEntityNotes, getLinkGraph, getNotesByType } from '../utils/vaultQuery';
import {
	sanitizeFilename, buildYamlArray, buildYamlTagArray, buildDateField,
	ensureFolder, deduplicatePath, today,
} from '../utils/noteBuilder';
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
		`relationships: []`,
		`created: ${today()}`,
		`tags: ${buildYamlTagArray(note.tags)}`,
		'---',
		'',
		`${imageEmbed}${note.bio}`,
	].join('\n');
}

function buildEventContent(note: EventNote): string {
	const abstractLines = note.description
		? note.description.split('\n').map(l => `> ${l}`).join('\n')
		: '';
	const abstract = abstractLines ? `> [!abstract] Summary\n${abstractLines}\n` : '';

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
		`relationships: []`,
		`created: ${today()}`,
		`tags: ${buildYamlTagArray(note.tags)}`,
		'---',
		'',
		abstract,
		'## Commentary',
		'',
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
		`relationships: []`,
		`created: ${today()}`,
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
			description: '',
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
			description: pageData.summary || '',
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
	if (parts.length < 2 || !parts[0] || !parts[1]) {
		addMessage('assistant', 'Usage: `/link Entity A | Entity B` or `/link Entity A | Entity B | relationship` — e.g. `/link Kissinger | Nixon | served under`');
		return;
	}

	const [nameA, nameB] = parts as [string, string];
	const relationship = parts[2] ?? null;
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

	let newContentA = appendToField(contentA, fieldA, fileB.basename);
	let newContentB = appendToField(contentB, fieldB, fileA.basename);

	// Typed relationship: append to `relationships` array in both notes
	if (relationship) {
		const entryA = `{target: "[[${fileB.basename}]]", type: "${relationship.replace(/"/g, '\\"')}"}`;
		const entryB = `{target: "[[${fileA.basename}]]", type: "${relationship.replace(/"/g, '\\"')}"}`;
		newContentA = appendTypedRelationship(newContentA, entryA);
		newContentB = appendTypedRelationship(newContentB, entryB);
	}

	await app.vault.modify(fileA, newContentA);
	await app.vault.modify(fileB, newContentB);

	const relLabel = relationship ? ` (${relationship})` : '';
	replaceMessage('assistant', `Linked **[[${fileA.basename}]]** ↔ **[[${fileB.basename}]]**${relLabel}`);
}

function appendTypedRelationship(content: string, entry: string): string {
	// Append to existing relationships array or insert field before closing ---
	const fieldRegex = /(^relationships:[^\n]*(?:\n  -[^\n]*)*)/m;
	const match = fieldRegex.exec(content);
	if (match) {
		const insertion = `\n  - ${entry}`;
		return content.slice(0, match.index + match[0].length) + insertion + content.slice(match.index + match[0].length);
	}
	const closingFm = content.indexOf('\n---', 3);
	if (closingFm !== -1) {
		return content.slice(0, closingFm) + `\nrelationships:\n  - ${entry}` + content.slice(closingFm);
	}
	return content;
}

// ── /bridge ───────────────────────────────────────────────────────────────

export async function executeBridge(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const parts = args.split('|').map(s => s.trim());
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		addMessage('assistant', 'Usage: `/bridge Entity A | Entity B` — e.g. `/bridge Kissinger | Mao Zedong`');
		return;
	}

	const [nameA, nameB] = parts as [string, string];
	const entityFolders = [settings.peopleFolder, settings.eventsFolder, settings.ideasFolder];

	const fileA = findEntityByName(app, nameA, entityFolders);
	const fileB = findEntityByName(app, nameB, entityFolders);

	if (!fileA || !fileB) {
		const missing = [!fileA && nameA, !fileB && nameB].filter(Boolean);
		addMessage('assistant', `Could not find entity notes for: ${(missing as string[]).map(n => `**${n}**`).join(', ')}.`);
		return;
	}

	if (fileA.path === fileB.path) {
		addMessage('assistant', 'Both names resolve to the same note.');
		return;
	}

	addMessage('assistant', `Finding path from **[[${fileA.basename}]]** to **[[${fileB.basename}]]**…`);

	const graph = getLinkGraph(app, entityFolders);

	// BFS
	const visited = new Set<string>([fileA.path]);
	const queue: string[][] = [[fileA.path]];
	let foundPath: string[] | null = null;
	const MAX_HOPS = 6;

	while (queue.length > 0 && !foundPath) {
		const path = queue.shift()!;
		if (path.length > MAX_HOPS + 1) break;
		const current = path[path.length - 1]!;
		for (const neighbor of graph.get(current) ?? []) {
			if (visited.has(neighbor)) continue;
			const newPath = [...path, neighbor];
			if (neighbor === fileB.path) { foundPath = newPath; break; }
			visited.add(neighbor);
			queue.push(newPath);
		}
	}

	if (!foundPath) {
		replaceMessage('assistant',
			`No path found between **[[${fileA.basename}]]** and **[[${fileB.basename}]]** within ${MAX_HOPS} hops. The two entities may not be connected yet — try /link-ing them through intermediaries first.`
		);
		return;
	}

	// Build rationale for each hop
	const files = app.vault.getMarkdownFiles();
	const pathFiles = foundPath.map(p => files.find(f => f.path === p)).filter(Boolean) as typeof files;

	const hops: string[] = [];
	for (let i = 0; i < pathFiles.length - 1; i++) {
		const a = pathFiles[i]!;
		const b = pathFiles[i + 1]!;
		let rationale = '';
		try {
			const [ca, cb] = await Promise.all([app.vault.cachedRead(a), app.vault.cachedRead(b)]);
			rationale = await callOllama({
				model,
				ollamaUrl: config.ollamaUrl,
				messages: [{ role: 'user', content: Prompts.bridgeHopRationale(ca, cb) }],
			});
		} catch { /* skip rationale */ }
		hops.push(`**[[${a.basename}]]** → **[[${b.basename}]]**${rationale ? `\n> ${rationale.trim()}` : ''}`);
	}

	replaceMessage('assistant', `## Bridge: ${fileA.basename} → ${fileB.basename}\n\n${hops.join('\n\n')}`);
}

// ── /timeline ─────────────────────────────────────────────────────────────

export async function executeTimeline(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const query = args.trim();
	if (!query) {
		addMessage('assistant', 'Usage: `/timeline <topic>` or `/timeline <name>` or `/timeline 1990..2000`');
		return;
	}

	addMessage('assistant', `Building timeline for **${query}**…`);

	// Include notes with type:event frontmatter OR located in any configured timeline folder
	const timelineFolders = settings.timelineFolders
		.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
	const byType = getNotesByType(app, 'event');
	const byFolder = getEntityNotes(app, timelineFolders);
	const seen = new Set<string>();
	const eventFiles = [...byType, ...byFolder].filter(f => {
		if (seen.has(f.path)) return false;
		seen.add(f.path);
		return true;
	});
	if (eventFiles.length === 0) {
		replaceMessage('assistant', 'No event notes found. Create some with `/event` first.');
		return;
	}

	// Parse date range
	const dateRangeMatch = query.match(/^(\d{4})\.\.(\d{4})$/);

	const filtered = eventFiles.filter(f => {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) return false;
		if (dateRangeMatch) {
			const year = parseInt((fm['date'] as string | undefined ?? '').slice(0, 4));
			const from = parseInt(dateRangeMatch[1]!);
			const to = parseInt(dateRangeMatch[2]!);
			return !isNaN(year) && year >= from && year <= to;
		}
		// Person name lookup — search people folder specifically, then check participants field
		const person = findEntityByName(app, query, [settings.peopleFolder]);
		if (person) {
			const participants = fm['participants'];
			if (Array.isArray(participants)) {
				return participants.some((p: unknown) =>
					typeof p === 'string' && p.toLowerCase().includes(person.basename.toLowerCase())
				);
			}
			return false;
		}
		// Keyword match on title, timeline_tags
		const lower = query.toLowerCase();
		const titleMatch = f.basename.toLowerCase().includes(lower);
		const tagMatch = (fm['timeline_tags'] as string[] | undefined ?? [])
			.some(t => t.toLowerCase().includes(lower));
		return titleMatch || tagMatch;
	});

	if (filtered.length === 0) {
		replaceMessage('assistant', `No event notes found matching **"${query}"**.`);
		return;
	}

	// Sort chronologically — validate date is a string before comparing
	const sorted = filtered.slice().sort((a, b) => {
		const rawA = app.metadataCache.getFileCache(a)?.frontmatter?.['date'];
		const rawB = app.metadataCache.getFileCache(b)?.frontmatter?.['date'];
		const da = typeof rawA === 'string' ? rawA : '';
		const db = typeof rawB === 'string' ? rawB : '';
		return da.localeCompare(db);
	});

	// Build timeline rows
	const rows: string[] = [];
	for (const file of sorted) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const date = (fm['date'] as string | undefined) ?? '(unknown date)';
		let summary = '';
		try {
			const body = await app.vault.cachedRead(file);
			const bodyText = body.replace(/^---[\s\S]*?---\n/, '').trim();
			const firstPara = bodyText.split('\n\n')[0]?.trim() ?? '';
			if (firstPara && firstPara.length < 200) {
				// Short enough to use directly
				summary = firstPara;
			} else if (bodyText.length > 50) {
				// Only call AI when there is enough content to summarize
				summary = await callOllama({
					model, ollamaUrl: config.ollamaUrl,
					messages: [{ role: 'user', content: Prompts.timelineSummary(bodyText) }],
				});
			}
		} catch { /* skip summary */ }
		rows.push(`**${date}** — [[${file.basename}]]${summary ? `: ${summary.trim()}` : ''}`);
	}

	replaceMessage('assistant', `## Timeline: ${query}\n\n${rows.join('\n')}`);
}
