import { App, TFile } from 'obsidian';
import { callOllama, callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { AIAgentSettings } from '../settings';
import { CommandConfig, AddMessage, ReplaceMessage } from './slashCommands';
import {
	ensureFolder, deduplicatePath, today, buildYamlTags,
} from '../utils/noteBuilder';
import {
	getNotesModifiedSince, getNotesByFrontmatterTag, getNotesByType,
} from '../utils/vaultQuery';
import { chunkText } from '../utils/chunking';
import { SocraticModal } from '../ui/SocraticModal';

// ── /socratic ─────────────────────────────────────────────────────────────

interface SocraticResult { questions: string[] }
const SOCRATIC_SCHEMA = {
	type: 'object',
	properties: { questions: { type: 'array', items: { type: 'string' } } },
	required: ['questions'],
};

export async function executeSocratic(
	_args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
): Promise<void> {
	const file = app.workspace.getActiveFile();
	if (!file) {
		addMessage('assistant', 'No active note. Open a note first, then run `/socratic`.');
		return;
	}
	const content = await app.vault.cachedRead(file);
	const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
	if (body.length < 200) {
		addMessage('assistant', `**${file.basename}** is too short for Socratic questioning (< 200 chars).`);
		return;
	}

	addMessage('assistant', `Generating questions for **${file.basename}**…`);
	let result: SocraticResult;
	try {
		result = await callOllamaStructured<SocraticResult>({
			model, ollamaUrl: config.ollamaUrl,
			messages: [{ role: 'user', content: Prompts.socraticQuestions(body) }],
			format: SOCRATIC_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to generate questions: ${msg}`);
		return;
	}

	const questions = (result.questions ?? []).filter(q => q.trim().length > 0).slice(0, 5);
	if (questions.length === 0) {
		replaceMessage('assistant', 'Could not generate questions for this note.');
		return;
	}

	replaceMessage('assistant', `Generated ${questions.length} questions. Answering in modal…`);

	await new Promise<void>(resolve => {
		new SocraticModal(app, questions, async (answers) => {
			const date = today();
			const lines = questions.map((q, i) => `**Q:** ${q}\n**A:** ${answers[i]?.trim() || '*(no answer)*'}`);
			const appendText = `\n\n## Socratic — ${date}\n\n${lines.join('\n\n')}`;
			try {
				const latest = await app.vault.read(file);
				await app.vault.modify(file, latest + appendText);
				replaceMessage('assistant', `Saved ${questions.length} Q&A pairs to **[[${file.basename}]]**.`);
			} catch {
				replaceMessage('assistant', 'Questions generated but could not save answers to note.');
			}
			resolve();
		}).open();
	});
}

// ── /recluster ────────────────────────────────────────────────────────────

interface ReclusterResult {
	clusters: Array<{ title: string; moc_title: string; notes: string[]; rationale: string }>;
}
const RECLUSTER_SCHEMA = {
	type: 'object',
	properties: {
		clusters: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					moc_title: { type: 'string' },
					notes: { type: 'array', items: { type: 'string' } },
					rationale: { type: 'string' },
				},
				required: ['title', 'moc_title', 'notes', 'rationale'],
			},
		},
	},
	required: ['clusters'],
};

export async function executeRecluster(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const folder = args.trim() || settings.clipsFolder;
	const files = app.vault.getMarkdownFiles()
		.filter(f => f.parent?.path === folder)
		.sort((a, b) => b.stat.mtime - a.stat.mtime)
		.slice(0, settings.reclusterMaxNotes);

	if (files.length < 5) {
		addMessage('assistant', `\`${folder}\` has fewer than 5 notes — not enough to cluster.`);
		return;
	}

	addMessage('assistant', `Clustering ${files.length} notes in \`${folder}\`…`);

	const reps: string[] = [];
	for (const file of files) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const tags = (fm['tags'] as string[] | undefined ?? []).join(', ');
		let body = '';
		try {
			const raw = await app.vault.cachedRead(file);
			body = raw.replace(/^---[\s\S]*?---\n/, '').slice(0, 500).trim();
		} catch { /* skip */ }
		reps.push(`--- ${file.basename}\nTags: ${tags}\n${body}`);
	}

	let result: ReclusterResult;
	try {
		result = await callOllamaStructured<ReclusterResult>({
			model, ollamaUrl: config.ollamaUrl,
			messages: [{ role: 'user', content: Prompts.reclusterNotes(reps.join('\n\n')) }],
			format: RECLUSTER_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to cluster notes: ${msg}`);
		return;
	}

	const reportFolder = `${settings.reflectionsFolder}/Reclusters`;
	await ensureFolder(app, settings.reflectionsFolder);
	await ensureFolder(app, reportFolder);
	const reportPath = await deduplicatePath(app, `${reportFolder}/${today()}`);

	const lines = (result.clusters ?? []).map(c => {
		const noteLinks = c.notes.map(n => `- [[${n}]]`).join('\n');
		return `## ${c.title}\n**Suggested MOC:** ${c.moc_title}\n*${c.rationale}*\n\n${noteLinks}`;
	});

	const reportContent = `---\ntype: recluster\ncreated: ${today()}\n---\n\n# Recluster: ${folder} — ${today()}\n\n${lines.join('\n\n')}`;
	await app.vault.create(reportPath, reportContent);

	replaceMessage('assistant', `Saved cluster report to **[[${reportPath.split('/').pop()?.replace('.md', '')}]]**.`);
}

// ── /contradict ───────────────────────────────────────────────────────────

interface ClaimsResult { claims: string[] }
const CLAIMS_SCHEMA = {
	type: 'object',
	properties: { claims: { type: 'array', items: { type: 'string' } } },
	required: ['claims'],
};

interface ContradictResult { contradicts: boolean; reason: string }
const CONTRADICT_SCHEMA = {
	type: 'object',
	properties: { contradicts: { type: 'boolean' }, reason: { type: 'string' } },
	required: ['contradicts', 'reason'],
};

export async function executeContradict(
	_args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
): Promise<void> {
	const file = app.workspace.getActiveFile();
	if (!file) {
		addMessage('assistant', 'No active note. Open a note first, then run `/contradict`.');
		return;
	}
	const content = await app.vault.cachedRead(file);
	const body = content.replace(/^---[\s\S]*?---\n/, '').trim();

	addMessage('assistant', `Extracting claims from **${file.basename}**…`);

	let claimsResult: ClaimsResult;
	try {
		claimsResult = await callOllamaStructured<ClaimsResult>({
			model, ollamaUrl: config.ollamaUrl,
			messages: [{ role: 'user', content: Prompts.extractClaims(body) }],
			format: CLAIMS_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to extract claims: ${msg}`);
		return;
	}

	const claims = (claimsResult.claims ?? []).filter(c => c.trim()).slice(0, 8);
	if (claims.length === 0) {
		replaceMessage('assistant', 'No load-bearing claims found in this note.');
		return;
	}

	replaceMessage('assistant', `Checking ${claims.length} claims across vault…`);

	const allFiles = app.vault.getMarkdownFiles().filter(f => f.path !== file.path);
	const findings: string[] = [];

	for (const claim of claims) {
		// Find candidate notes by keyword
		const terms = claim.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 4);
		const candidates = allFiles.filter(f =>
			terms.some(t => f.basename.toLowerCase().includes(t))
		).slice(0, 10);

		for (const candidate of candidates) {
			let noteContent: string;
			try { noteContent = await app.vault.cachedRead(candidate); } catch { continue; }
			let res: ContradictResult;
			try {
				res = await callOllamaStructured<ContradictResult>({
					model, ollamaUrl: config.ollamaUrl,
					messages: [{ role: 'user', content: Prompts.detectContradiction(claim, noteContent) }],
					format: CONTRADICT_SCHEMA,
				});
			} catch { continue; }
			if (res.contradicts) {
				findings.push(`**Claim:** ${claim}\n**Contradicted by [[${candidate.basename}]]:** ${res.reason}`);
			}
		}
	}

	if (findings.length === 0) {
		replaceMessage('assistant', `No contradictions found for the ${claims.length} claims in **${file.basename}**.`);
		return;
	}

	const appendText = `\n\n## Contradictions — ${today()}\n\n${findings.join('\n\n')}`;
	replaceMessage('assistant', `Found ${findings.length} contradiction(s) — appending to note.\n\n${findings.join('\n\n')}`);
	await app.vault.modify(file, content + appendText);
}

// ── /sources ──────────────────────────────────────────────────────────────

export async function executeSources(
	_args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
): Promise<void> {
	const file = app.workspace.getActiveFile();
	if (!file) {
		addMessage('assistant', 'No active note. Open a note first, then run `/sources`.');
		return;
	}
	const content = await app.vault.cachedRead(file);
	addMessage('assistant', `Auditing citations in **${file.basename}**…`);

	let result: ClaimsResult;
	try {
		result = await callOllamaStructured<ClaimsResult>({
			model, ollamaUrl: config.ollamaUrl,
			messages: [{ role: 'user', content: Prompts.sourcesUncited(content) }],
			format: CLAIMS_SCHEMA,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to audit note: ${msg}`);
		return;
	}

	const claims = (result.claims ?? []).filter(c => c.trim());
	if (claims.length === 0) {
		replaceMessage('assistant', `No uncited claims found in **${file.basename}**.`);
		return;
	}

	const checkboxes = claims.map(c => `- [ ] ${c}`).join('\n');
	const appendText = `\n\n## Claims needing sources\n${checkboxes}`;
	const latest = await app.vault.read(file);
	await app.vault.modify(file, latest + appendText);
	replaceMessage('assistant', `Found ${claims.length} uncited claim(s) — appended to **[[${file.basename}]]**.`);
}

// ── /thesis ───────────────────────────────────────────────────────────────

export async function executeThesis(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const ticker = args.trim();
	if (!ticker) {
		addMessage('assistant', 'Usage: `/thesis <ticker or theme>` — e.g. `/thesis BTC` or `/thesis artificial-intelligence`');
		return;
	}

	addMessage('assistant', `Building thesis for **${ticker}**…`);

	const taggedFiles = getNotesByFrontmatterTag(app, ticker);
	if (taggedFiles.length === 0) {
		replaceMessage('assistant', `No notes tagged with \`${ticker}\`.`);
		return;
	}

	// Build bundle
	const parts: string[] = [];
	for (const file of taggedFiles) {
		let body = '';
		try { body = await app.vault.cachedRead(file); } catch { continue; }
		parts.push(`### [[${file.basename}]]\n${body.replace(/^---[\s\S]*?---\n/, '').slice(0, 1500)}`);
	}
	const bundle = parts.join('\n\n');

	// Chunk if too large
	let thesis: string;
	try {
		if (bundle.length <= 4000) {
			thesis = await callOllama({
				model, ollamaUrl: config.ollamaUrl,
				messages: [{ role: 'user', content: Prompts.thesisDocument(bundle) }],
			});
		} else {
			const chunks = chunkText(bundle, 3000);
			const summaries: string[] = [];
			for (const chunk of chunks) {
				const s = await callOllama({
					model, ollamaUrl: config.ollamaUrl,
					messages: [{ role: 'user', content: Prompts.thesisDocument(chunk) }],
				});
				summaries.push(s);
			}
			thesis = summaries.join('\n\n---\n\n');
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Failed to generate thesis: ${msg}`);
		return;
	}

	await ensureFolder(app, settings.thesesFolder);
	const filePath = await deduplicatePath(app, `${settings.thesesFolder}/${ticker}-${today()}`);
	const yamlTags = buildYamlTags([ticker]);
	const fileContent = `---\ntype: thesis\nsubject: "${ticker}"\ncreated: ${today()}\ntags:\n${yamlTags}\n---\n\n${thesis}`;
	await app.vault.create(filePath, fileContent);

	const displayName = filePath.split('/').pop()?.replace('.md', '') ?? ticker;
	replaceMessage('assistant', `Thesis saved to **[[${displayName}]]**.`);
}

// ── /weekly and /monthly ──────────────────────────────────────────────────

export async function executeReflection(
	period: 'weekly' | 'monthly',
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	addMessage('assistant', `Building ${period} reflection…`);

	const days = period === 'weekly' ? 7 : 30;
	const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	const modifiedFiles = getNotesModifiedSince(app, since);

	// Extract themes (tags) and entities
	const tagCounts = new Map<string, number>();
	const entityNames: string[] = [];
	const openQuestions: string[] = [];

	for (const file of modifiedFiles) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const fmType = fm['type'] as string | undefined;
		if (['person', 'event', 'idea'].includes(fmType ?? '')) {
			entityNames.push(file.basename);
		}
		const tags = fm['tags'];
		if (Array.isArray(tags)) {
			for (const t of tags) {
				if (typeof t === 'string' && t !== 'ai' && t !== 'clip') {
					tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
				}
			}
		}
		// Scan for open questions (lines ending with ?)
		try {
			const body = await app.vault.cachedRead(file);
			const questions = body.match(/^[^#\-].+\?$/gm) ?? [];
			openQuestions.push(...questions.slice(0, 2));
		} catch { /* skip */ }
	}

	const themes = [...tagCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([t, n]) => `${t} (${n})`)
		.join(', ');

	const entitySummary = entityNames.slice(0, 15).join(', ') || 'none';
	const questionSummary = openQuestions.slice(0, 5).join(' | ') || 'none found';

	let scaffold = '';
	if (modifiedFiles.length === 0) {
		scaffold = `## Notes\n\nNo notes were modified in the past ${days} days.\n\n## What surprised you\n*(your reflection here)*\n\n## What you want to revisit\n*(your reflection here)*\n\n## Free reflection\n*(your reflection here)*`;
	} else {
		try {
			scaffold = await callOllama({
				model, ollamaUrl: config.ollamaUrl,
				messages: [{ role: 'user', content: Prompts.reflectionScaffold(themes, entitySummary, questionSummary) }],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			replaceMessage('assistant', `Failed to generate scaffold: ${msg}`);
			return;
		}
	}

	// Determine file path
	const now = new Date();
	let filename: string;
	if (period === 'weekly') {
		const week = getISOWeek(now);
		filename = `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
	} else {
		filename = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	}
	const filePath = `${settings.reflectionsFolder}/${filename}.md`;

	await ensureFolder(app, settings.reflectionsFolder);

	const existingFile = app.vault.getAbstractFileByPath(filePath);
	if (existingFile instanceof TFile) {
		const existing = await app.vault.read(existingFile);
		const rerunHeader = `\n\n## Re-run ${today()} ${new Date().toTimeString().slice(0, 5)}\n\n`;
		await app.vault.modify(existingFile, existing + rerunHeader + scaffold);
	} else {
		const yamlTags = buildYamlTags([period === 'weekly' ? 'weekly-reflection' : 'monthly-reflection']);
		const fileContent = `---\ntype: reflection\ncreated: ${today()}\ntags:\n${yamlTags}\n---\n\n${scaffold}`;
		await app.vault.create(filePath, fileContent);
	}

	const file = app.vault.getAbstractFileByPath(filePath);
	if (file instanceof TFile) {
		await app.workspace.getLeaf().openFile(file);
	}

	replaceMessage('assistant', `${period === 'weekly' ? 'Weekly' : 'Monthly'} reflection opened in editor.`);
}

function getISOWeek(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// ── /freewrite ────────────────────────────────────────────────────────────

export async function executeFreewrite(
	_args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	settings: AIAgentSettings,
): Promise<void> {
	const frewriteFolder = `${settings.reflectionsFolder}/Freewrites`;
	await ensureFolder(app, settings.reflectionsFolder);
	await ensureFolder(app, frewriteFolder);

	const now = new Date();
	const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
	const base = `${frewriteFolder}/${today()}-${hhmm}`;
	const filePath = await deduplicatePath(app, base);

	const content = `---\ntype: freewrite\ncreated: ${today()}\n---\n\n`;
	addMessage('assistant', 'Opening freewrite…');
	const file = await app.vault.create(filePath, content);
	await app.workspace.getLeaf().openFile(file);
	replaceMessage('assistant', `Opened **[[${file.basename}]]** — start writing.`);
}
