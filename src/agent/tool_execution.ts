/**
 * agent/tool_execution.ts
 *
 * Unified tool execution — bridges the agent's structured ToolCall objects to
 * the actual command implementations in commands/*.ts.
 *
 * Each tool handler receives params validated against the tool schema and
 * returns a markdown string that gets injected back into the agent's context.
 *
 * Design: handlers are self-contained, return strings, and surface errors
 * via the return value rather than throwing — the loop always gets a result
 * it can inject back as tool output.
 */

import { App, requestUrl, TFile } from 'obsidian';
import type { AIAgentSettings } from '../settings';
import { getToolByName } from './tool_schemas';
import type { ToolCall } from '../schemas/index';
import {
	executeWrite,
	executeClip,
	executeFind,
	type CommandConfig,
} from '../commands/slashCommands';
import {
	executeCreatePerson,
	executeCreateEvent,
	executeCreateIdea,
	executeCreateEntity,
	executeLink,
} from '../commands/humanNetworkCommands';
import {
	executeSocratic,
	executeSources,
	executeReflection,
} from '../commands/reflectionCommands';
import {
	executeStandardize,
} from '../commands/miscCommands';
import {
	mapReduceSummarize,
} from '../utils/chunking';
import {
	findEntityByName,
	getLinkGraph,
	getNotesModifiedSince,
} from '../utils/vaultQuery';
import {
	sanitizeFilename,
	buildYamlTags,
	today,
	ensureFolder,
	deduplicatePath,
} from '../utils/noteBuilder';

// ── Message capture adapter ───────────────────────────────────────────────
// Existing commands write to addMessage/replaceMessage callbacks.
// We capture those outputs as strings so the agent loop can inject them.

function captureMessages(): {
	messages: string[];
	addMessage: (role: string, content: string) => void;
	replaceMessage: (role: string, content: string) => void;
	last: () => string;
} {
	const messages: string[] = [];
	return {
		messages,
		addMessage:    (_r: string, c: string) => { messages.push(c); },
		replaceMessage:(_r: string, c: string) => {
			if (messages.length > 0) messages[messages.length - 1] = c;
			else messages.push(c);
		},
		last: () => messages[messages.length - 1] ?? '',
	};
}

// ── Param helpers ─────────────────────────────────────────────────────────

function str(params: Record<string, unknown>, key: string, fallback = ''): string {
	const v = params[key];
	return typeof v === 'string' ? v : fallback;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
	const v = params[key];
	return typeof v === 'number' ? v : fallback;
}

function bool(params: Record<string, unknown>, key: string, fallback = false): boolean {
	const v = params[key];
	return typeof v === 'boolean' ? v : fallback;
}

// ── Individual tool handlers ──────────────────────────────────────────────

async function handleVaultSearch(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const query = str(params, 'query');
	const folder = str(params, 'folder');
	const limit  = num(params, 'limit', 10);
	if (!query) return 'ERROR: vault_search requires a query parameter.';

	const { addMessage, replaceMessage, addFindResults } = {
		addMessage: () => {},
		replaceMessage: () => {},
		addFindResults: (_q: string, _c: unknown[]) => {},
	};

	// Re-implement find directly so we can return a structured string
	const files = app.vault.getMarkdownFiles()
		.filter(f => !folder || f.path.startsWith(folder + '/') || f.parent?.path === folder);

	const terms = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
	const matchMap = new Map<string, Set<string>>();

	for (const term of terms) {
		for (const file of files) {
			if (file.basename.toLowerCase().includes(term)) {
				if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
				matchMap.get(file.path)!.add(term);
				continue;
			}
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			const title = ((fm?.['name'] ?? fm?.['title'] ?? '') as string).toLowerCase();
			if (title && title.includes(term)) {
				if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
				matchMap.get(file.path)!.add(term);
			}
		}
	}

	// Body scan for unmatched files
	const unmatched = files.filter(f => !matchMap.has(f.path)).slice(0, 200);
	for (const file of unmatched) {
		try {
			const text = (await app.vault.cachedRead(file)).toLowerCase();
			for (const term of terms) {
				if (text.includes(term)) {
					if (!matchMap.has(file.path)) matchMap.set(file.path, new Set());
					matchMap.get(file.path)!.add(term);
				}
			}
		} catch { /* skip unreadable */ }
	}

	if (matchMap.size === 0) return `No notes found for "${query}".`;

	const results = [...matchMap.entries()]
		.sort((a, b) => b[1].size - a[1].size)
		.slice(0, Math.min(limit, 20))
		.map(([path, termSet]) => {
			const basename = path.replace(/^.*\//, '').replace(/\.md$/, '');
			return `- [[${basename}]] (matched: ${[...termSet].join(', ')})`;
		});

	return `Found ${matchMap.size} notes for "${query}"${matchMap.size > limit ? ` (showing top ${limit})` : ''}:\n\n${results.join('\n')}`;

	void addMessage; void replaceMessage; void addFindResults; void cfg;
}

async function handleReadNote(params: Record<string, unknown>, app: App): Promise<string> {
	const name = str(params, 'name');
	if (!name) return 'ERROR: read_note requires a name parameter.';

	const files = app.vault.getMarkdownFiles();
	const file = files.find(f =>
		f.basename.toLowerCase() === name.toLowerCase() ||
		f.path === name ||
		f.path === name + '.md'
	);

	if (!file) return `Note not found: "${name}". Try vault_search first.`;

	try {
		const content = await app.vault.cachedRead(file);
		const preview = content.length > 6000
			? content.slice(0, 6000) + '\n\n[… truncated at 6000 chars — use edit_note to modify specific sections]'
			: content;
		return `## [[${file.basename}]]\n\n${preview}`;
	} catch (err) {
		return `Failed to read "${name}": ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleWriteNote(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings
): Promise<string> {
	const filename = str(params, 'filename');
	const content  = str(params, 'content');
	const folder   = str(params, 'folder', settings.aiNotesFolder);
	if (!filename) return 'ERROR: write_note requires a filename parameter.';
	if (!content)  return 'ERROR: write_note requires a content parameter.';

	try {
		await ensureFolder(app, folder);
		const base = folder ? `${folder}/${sanitizeFilename(filename)}` : sanitizeFilename(filename);
		const path = await deduplicatePath(app, base);
		await app.vault.create(path, content);
		const displayName = path.replace(/^.*\//, '').replace(/\.md$/, '');
		return `Created [[${displayName}]] at \`${path}\`.`;
	} catch (err) {
		return `Failed to create note: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleEditNote(params: Record<string, unknown>, app: App): Promise<string> {
	const name    = str(params, 'name');
	const find    = str(params, 'find');
	const replace = str(params, 'replace');
	if (!name)    return 'ERROR: edit_note requires a name parameter.';
	if (!find)    return 'ERROR: edit_note requires a find parameter.';
	if (replace === '') return 'ERROR: edit_note requires a replace parameter (use a space character to effectively delete).';

	const files = app.vault.getMarkdownFiles();
	const file = files.find(f =>
		f.basename.toLowerCase() === name.toLowerCase() ||
		f.path === name ||
		f.path === name + '.md'
	);
	if (!file) return `Note not found: "${name}".`;

	try {
		const content = await app.vault.cachedRead(file);
		const occurrences = content.split(find).length - 1;
		if (occurrences === 0) return `Find string not found in [[${file.basename}]]. The note may have changed — use read_note to check the current content.`;
		if (occurrences > 1) return `Find string appears ${occurrences} times in [[${file.basename}]] — provide more surrounding context to make it unique.`;

		await app.vault.modify(file, content.replace(find, replace));
		return `Updated [[${file.basename}]].`;
	} catch (err) {
		return `Failed to edit note: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleCreateEntity(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const type    = str(params, 'type', 'entity');
	const name    = str(params, 'name');
	const context = str(params, 'context');
	if (!name) return 'ERROR: create_entity requires a name parameter.';

	const capture = captureMessages();
	const args = context ? `${name} | ${context}` : name;

	try {
		switch (type) {
			case 'person':
				await executeCreatePerson(name, app, capture.addMessage, capture.replaceMessage, cfg.ollamaUrl.includes('model') ? '' : settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
				break;
			case 'event':
				await executeCreateEvent(name, app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
				break;
			case 'idea':
				await executeCreateIdea(name, app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
				break;
			default:
				await executeCreateEntity(`${type} | ${args}`, app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
				break;
		}
		return capture.last() || `Created entity: [[${name}]]`;
	} catch (err) {
		return `Failed to create entity: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleLinkEntities(params: Record<string, unknown>, app: App): Promise<string> {
	const entityA = str(params, 'entity_a');
	const entityB = str(params, 'entity_b');
	const rel     = str(params, 'relationship');
	if (!entityA || !entityB) return 'ERROR: link_entities requires entity_a and entity_b parameters.';

	const capture = captureMessages();
	try {
		const arg = rel ? `${entityA} | ${entityB} | ${rel}` : `${entityA} | ${entityB}`;
		await executeLink(arg, app, capture.addMessage, capture.replaceMessage);
		return capture.last() || `Linked [[${entityA}]] ↔ [[${entityB}]].`;
	} catch (err) {
		return `Failed to link entities: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleWikiLookup(
	params: Record<string, unknown>,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const query    = str(params, 'query');
	const detailed = str(params, 'detailed', 'brief') === 'detailed';
	if (!query) return 'ERROR: wiki_lookup requires a query parameter.';

	// Wikipedia search
	try {
		const searchResp = await requestUrl({
			url: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`,
			throw: false,
		});
		if (searchResp.status >= 400) throw new Error(`Wikipedia search HTTP ${searchResp.status}`);
		const searchData = searchResp.json as { query?: { search?: Array<{ title: string; snippet: string }> } };
		const results = searchData.query?.search ?? [];
		if (results.length === 0) return `Wikipedia: no results for "${query}".`;

		const topTitle = results[0]?.title ?? '';
		const pageResp = await requestUrl({
			url: `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=${detailed ? '' : '&exintro'}&titles=${encodeURIComponent(topTitle)}&format=json&origin=*`,
			throw: false,
		});
		const pageData = pageResp.json as { query?: { pages?: Record<string, { extract?: string; title: string }> } };
		const pages = Object.values(pageData.query?.pages ?? {});
		const page = pages[0];
		if (!page) return `Wikipedia: could not fetch page for "${topTitle}".`;

		// Strip HTML tags from extract
		const extract = (page.extract ?? '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
		const preview = detailed ? extract : extract.slice(0, 1500) + (extract.length > 1500 ? '…' : '');

		return `**Wikipedia: ${page.title}**\n\n${preview}\n\n*Source: model should offer to create entity note from this.*`;
	} catch (err) {
		return `Wikipedia lookup failed: ${err instanceof Error ? err.message : String(err)}. Use model knowledge and mark as (model knowledge — unverified).`;
	}
}

async function handleFetchUrl(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const url      = str(params, 'url');
	const detailed = str(params, 'detailed', 'brief') === 'detailed';
	if (!url || !/^https?:\/\//.test(url)) return 'ERROR: fetch_url requires a valid https:// URL.';

	const model = settings.roles.default.models[0] ?? settings.defaultModel;
	const capture = captureMessages();

	await executeClip(url, app, capture.addMessage, capture.replaceMessage, model, cfg, settings.clipsFolder, settings);
	return capture.last() || `Fetched and saved clip from ${url}.`;

	void detailed;
}

async function handleSummarizeMedia(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const url = str(params, 'url');
	if (!url) return 'ERROR: summarize_media requires a url parameter.';

	const model = settings.roles.default.models[0] ?? settings.defaultModel;
	const capture = captureMessages();

	await executeClip(url, app, capture.addMessage, capture.replaceMessage, model, cfg, settings.clipsFolder, settings);
	return capture.last() || `Summarized media from ${url}.`;
}

async function handleBridge(params: Record<string, unknown>, app: App, settings: AIAgentSettings): Promise<string> {
	const entityA = str(params, 'entity_a');
	const entityB = str(params, 'entity_b');
	if (!entityA || !entityB) return 'ERROR: bridge requires entity_a and entity_b parameters.';

	const allFolders = [
		settings.peopleFolder,
		settings.eventsFolder,
		settings.ideasFolder,
		settings.entitiesFolder,
	].filter(Boolean);

	const graph = getLinkGraph(app, allFolders);

	const fileA = findEntityByName(app, entityA, allFolders);
	const fileB = findEntityByName(app, entityB, allFolders);

	if (!fileA) return `Entity not found: "${entityA}". Use create_entity first or check the spelling.`;
	if (!fileB) return `Entity not found: "${entityB}". Use create_entity first or check the spelling.`;

	// BFS shortest path
	const queue: Array<{ path: string; chain: string[] }> = [{ path: fileA.path, chain: [fileA.basename] }];
	const visited = new Set<string>([fileA.path]);

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.path === fileB.path) {
			const chain = current.chain.map(n => `[[${n}]]`).join(' → ');
			return `**Bridge: ${chain}**\n\n${current.chain.length - 1} hop(s) between [[${entityA}]] and [[${entityB}]].`;
		}
		for (const neighbor of graph.get(current.path) ?? []) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor);
				const name = neighbor.replace(/^.*\//, '').replace(/\.md$/, '');
				queue.push({ path: neighbor, chain: [...current.chain, name] });
			}
		}
		if (queue.length > 500) break; // guard against enormous graphs
	}

	return `No direct link path found between [[${entityA}]] and [[${entityB}]] in the Human Network graph.\n\n*Embedding-space bridge (Phase 2) will find indirect connections via semantic similarity.*`;
}

async function handleTimeline(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings
): Promise<string> {
	const query     = str(params, 'query');
	const dateRange = str(params, 'date_range');

	const folderPaths = settings.timelineFolders.split(',').map(f => f.trim()).filter(Boolean);
	const files = app.vault.getMarkdownFiles().filter(f =>
		folderPaths.some(fp => f.path.startsWith(fp + '/') || f.parent?.path === fp)
	);

	const queryLower = query.toLowerCase();
	const dated: Array<{ date: string; name: string; path: string }> = [];

	for (const file of files) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const date = fm['date'] as string | undefined;
		if (!date) continue;

		// Filter by query if provided
		const name = file.basename.toLowerCase();
		const tags = (fm['tags'] as string[] | undefined) ?? [];
		const title = ((fm['title'] ?? fm['name'] ?? '') as string).toLowerCase();
		const matches = !query ||
			name.includes(queryLower) ||
			title.includes(queryLower) ||
			tags.some(t => t.toLowerCase().includes(queryLower));
		if (!matches) continue;

		// Filter by date range if provided
		if (dateRange) {
			const [start, end] = dateRange.includes('..') ? dateRange.split('..') : [dateRange, dateRange];
			if (start && date < (start ?? '')) continue;
			if (end   && date > (end   ?? '')) continue;
		}

		dated.push({ date, name: file.basename, path: file.path });
	}

	if (dated.length === 0) return `No dated notes found matching "${query}"${dateRange ? ` in range ${dateRange}` : ''}.`;

	dated.sort((a, b) => a.date.localeCompare(b.date));

	const lines = dated.slice(0, 50).map(d => `- **${d.date}** — [[${d.name}]]`);
	if (dated.length > 50) lines.push(`\n*(${dated.length - 50} more — refine with a tighter query or date range)*`);

	return `**Timeline: ${query}** (${dated.length} entries)\n\n${lines.join('\n')}`;
}

async function handleContradictNote(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	// Import the existing contradict handler dynamically (it lives in slashCommands or registerAll)
	const noteName = str(params, 'note_name');
	let file: TFile | null = null;
	if (noteName) {
		const files = app.vault.getMarkdownFiles();
		file = files.find(f => f.basename.toLowerCase() === noteName.toLowerCase()) ?? null;
	} else {
		file = app.workspace.getActiveFile();
	}
	if (!file) return 'No note to check. Open a note or pass note_name.';

	// Use existing /contradict logic from registerAll
	const capture = captureMessages();
	try {
		const { executeContradict } = await import('../commands/registerAll') as { executeContradict?: (args: string, app: App, add: (r: string, c: string) => void, replace: (r: string, c: string) => void, model: string, cfg: CommandConfig) => Promise<void> };
		if (executeContradict) {
			await executeContradict('', app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg);
		} else {
			return 'Contradict tool not available — run /contradict as a slash command instead.';
		}
		return capture.last() || 'Contradiction check complete.';
	} catch {
		return 'Contradiction check unavailable. Use /contradict as a slash command.';
	}
}

async function handleAuditSources(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const capture = captureMessages();
	try {
		await executeSources('', app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg);
		return capture.last() || 'Source audit complete.';
	} catch (err) {
		return `Source audit failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function handleRecluster(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const folder = str(params, 'folder');
	if (!folder) return 'ERROR: recluster requires a folder parameter.';
	const capture = captureMessages();
	// recluster is in registerAll / slashCommands
	try {
		const { executeRecluster } = await import('../commands/registerAll') as { executeRecluster?: (args: string, app: App, add: (r: string, c: string) => void, replace: (r: string, c: string) => void, model: string, cfg: CommandConfig, settings: AIAgentSettings) => Promise<void> };
		if (executeRecluster) {
			await executeRecluster(folder, app, capture.addMessage, capture.replaceMessage, settings.roles.research.models[0] ?? settings.defaultModel, cfg, settings);
		} else {
			return 'Recluster tool not available — use /recluster as a slash command.';
		}
		return capture.last() || `Reclustered folder: ${folder}.`;
	} catch {
		return 'Recluster unavailable. Use /recluster as a slash command.';
	}
}

async function handleThesis(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const topic = str(params, 'topic');
	if (!topic) return 'ERROR: thesis requires a topic parameter.';
	const capture = captureMessages();
	try {
		const { executeThesis } = await import('../commands/registerAll') as { executeThesis?: (args: string, app: App, add: (r: string, c: string) => void, replace: (r: string, c: string) => void, model: string, cfg: CommandConfig, settings: AIAgentSettings) => Promise<void> };
		if (executeThesis) {
			await executeThesis(topic, app, capture.addMessage, capture.replaceMessage, settings.roles.research.models[0] ?? settings.defaultModel, cfg, settings);
		} else {
			return 'Thesis tool not available — use /thesis as a slash command.';
		}
		return capture.last() || `Thesis draft generated for "${topic}".`;
	} catch {
		return 'Thesis generation unavailable. Use /thesis as a slash command.';
	}
}

async function handleSocratic(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const capture = captureMessages();
	await executeSocratic('', app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg);
	return capture.last() || 'Socratic questions generated.';
}

async function handleReflection(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const period = str(params, 'period', 'weekly') as 'weekly' | 'monthly';
	const capture = captureMessages();
	await executeReflection(period, app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
	return capture.last() || `${period} reflection generated.`;
}

async function handleStandardizeFolder(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const folder = str(params, 'folder');
	if (!folder) return 'ERROR: standardize_folder requires a folder parameter.';
	const capture = captureMessages();
	await executeStandardize(folder, app, capture.addMessage, capture.replaceMessage, settings.roles.utility.models[0] ?? settings.defaultModel, cfg);
	return capture.last() || `Metadata standardized in ${folder}.`;
}

async function handleIngestDocument(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const docPath = str(params, 'path');
	if (!docPath) return 'ERROR: ingest_document requires a path parameter.';
	const capture = captureMessages();
	try {
		const { executeIngest } = await import('../commands/ingestCommands') as { executeIngest?: (args: string, app: App, add: (r: string, c: string) => void, replace: (r: string, c: string) => void, model: string, cfg: CommandConfig, settings: AIAgentSettings) => Promise<void> };
		if (executeIngest) {
			await executeIngest(docPath, app, capture.addMessage, capture.replaceMessage, settings.roles.research.models[0] ?? settings.defaultModel, cfg, settings);
		} else {
			return 'Ingest tool not available — use /ingest as a slash command.';
		}
		return capture.last() || `Ingested ${docPath}.`;
	} catch {
		return 'Document ingestion unavailable. Use /ingest as a slash command.';
	}
}

async function handleTranscribe(
	params: Record<string, unknown>,
	app: App,
	settings: AIAgentSettings,
	cfg: CommandConfig
): Promise<string> {
	const filePath = str(params, 'path');
	if (!filePath) return 'ERROR: transcribe requires a path parameter.';
	const capture = captureMessages();
	try {
		const { executeTranscribe } = await import('../commands/registerAll') as { executeTranscribe?: (args: string, app: App, add: (r: string, c: string) => void, replace: (r: string, c: string) => void, model: string, cfg: CommandConfig, settings: AIAgentSettings) => Promise<void> };
		if (executeTranscribe) {
			await executeTranscribe(filePath, app, capture.addMessage, capture.replaceMessage, settings.roles.default.models[0] ?? settings.defaultModel, cfg, settings);
		} else {
			return 'Transcription tool not available — use /transcribe as a slash command.';
		}
		return capture.last() || `Transcribed ${filePath}.`;
	} catch {
		return 'Transcription unavailable. Use /transcribe as a slash command.';
	}
}

// ── Per-tool param validation ─────────────────────────────────────────────

export interface ValidationError {
	ok: false;
	error: string;
	tool: string;
	missing?: string[];
}

export function validateParams(call: ToolCall): ValidationError | null {
	const def = getToolByName(call.name);
	if (!def) return { ok: false, error: 'unknown_tool', tool: call.name };
	const missing = def.required.filter(k => !(k in call.params) || call.params[k] === '' || call.params[k] === null);
	if (missing.length > 0) {
		return { ok: false, error: 'missing_params', tool: call.name, missing };
	}
	return null;
}

// ── Main dispatcher ───────────────────────────────────────────────────────

export interface ToolResult {
	ok: boolean;
	output: string;
	duration_ms: number;
}

export async function executeTool(
	call: ToolCall,
	app: App,
	settings: AIAgentSettings
): Promise<ToolResult> {
	const start = Date.now();
	const cfg: CommandConfig = {
		ollamaUrl: settings.ollamaUrl,
		serverUrl: settings.serverUrl,
	};

	try {
		let output: string;

		switch (call.name) {
			case 'vault_search':
				output = await handleVaultSearch(call.params, app, settings, cfg);
				break;
			case 'read_note':
				output = await handleReadNote(call.params, app);
				break;
			case 'write_note':
				output = await handleWriteNote(call.params, app, settings);
				break;
			case 'edit_note':
				output = await handleEditNote(call.params, app);
				break;
			case 'create_entity':
				output = await handleCreateEntity(call.params, app, settings, cfg);
				break;
			case 'link_entities':
				output = await handleLinkEntities(call.params, app);
				break;
			case 'wiki_lookup':
				output = await handleWikiLookup(call.params, settings, cfg);
				break;
			case 'fetch_url':
				output = await handleFetchUrl(call.params, app, settings, cfg);
				break;
			case 'summarize_media':
				output = await handleSummarizeMedia(call.params, app, settings, cfg);
				break;
			case 'bridge':
				output = await handleBridge(call.params, app, settings);
				break;
			case 'timeline':
				output = await handleTimeline(call.params, app, settings);
				break;
			case 'contradict_note':
				output = await handleContradictNote(call.params, app, settings, cfg);
				break;
			case 'audit_sources':
				output = await handleAuditSources(call.params, app, settings, cfg);
				break;
			case 'recluster':
				output = await handleRecluster(call.params, app, settings, cfg);
				break;
			case 'thesis':
				output = await handleThesis(call.params, app, settings, cfg);
				break;
			case 'socratic':
				output = await handleSocratic(call.params, app, settings, cfg);
				break;
			case 'reflection':
				output = await handleReflection(call.params, app, settings, cfg);
				break;
			case 'standardize_folder':
				output = await handleStandardizeFolder(call.params, app, settings, cfg);
				break;
			case 'ingest_document':
				output = await handleIngestDocument(call.params, app, settings, cfg);
				break;
			case 'transcribe':
				output = await handleTranscribe(call.params, app, settings, cfg);
				break;
			default:
				output = `Unknown tool: "${call.name}". Available tools: ${getAllToolNames().join(', ')}.`;
		}

		return { ok: !output.startsWith('ERROR:'), output, duration_ms: Date.now() - start };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, output: `Tool "${call.name}" threw an error: ${msg}`, duration_ms: Date.now() - start };
	}
}

function getAllToolNames(): string[] {
	return ['vault_search', 'read_note', 'write_note', 'edit_note', 'create_entity',
		'link_entities', 'wiki_lookup', 'fetch_url', 'summarize_media', 'bridge',
		'timeline', 'contradict_note', 'audit_sources', 'recluster', 'thesis',
		'socratic', 'reflection', 'standardize_folder', 'ingest_document', 'transcribe'];
}
