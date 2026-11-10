import { App } from 'obsidian';
import { callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { AIAgentSettings } from '../settings';
import { CommandConfig, AddMessage, ReplaceMessage } from './slashCommands';
import { ensureFolder, deduplicatePath, sanitizeFilename, today } from '../utils/noteBuilder';

// ── Types ─────────────────────────────────────────────────────────────────

interface ChapterResult {
	summary: string;
	claims: string[];
	questions: string[];
}

interface ServerChapter {
	title: string;
	content: string;
}

const CHAPTER_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		claims: { type: 'array', items: { type: 'string' } },
		questions: { type: 'array', items: { type: 'string' } },
	},
	required: ['summary', 'claims', 'questions'],
};

// ── /ingest ───────────────────────────────────────────────────────────────

export async function executeIngest(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const filePath = args.trim();
	if (!filePath) {
		addMessage('assistant', 'Usage: `/ingest <file path or vault path>`');
		return;
	}

	let chapters: ServerChapter[];

	if (filePath.toLowerCase().endsWith('.pdf')) {
		// The Vizier server has no PDF extraction route yet.
		addMessage('assistant', 'PDF ingestion is not available in this version of Vizier. Convert the book to Markdown or plain text, add it to the vault, and run `/ingest` on that file.');
		return;
	} else {
		// Markdown: read from vault, AI processing via Ollama
		addMessage('assistant', `Ingesting **${filePath}**…`);
		const vaultFile = app.vault.getAbstractFileByPath(filePath);
		let rawContent: string;

		if (vaultFile && 'extension' in vaultFile) {
			try {
				rawContent = await app.vault.read(vaultFile as Parameters<typeof app.vault.read>[0]);
			} catch {
				addMessage('assistant', `Could not read vault file: ${filePath}`);
				return;
			}
		} else {
			addMessage('assistant', `File not found in vault: ${filePath}`);
			return;
		}

		// Split on H1/H2 headings
		const parts = rawContent.split(/^(#{1,2} .+)$/m);
		if (parts.length <= 1) {
			// No headings — treat as single chapter
			chapters = [{ title: filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Content', content: rawContent }];
		} else {
			chapters = [];
			let i = 1;
			while (i < parts.length) {
				const heading = (parts[i] ?? '').replace(/^#{1,2} /, '');
				const content = parts[i + 1] ?? '';
				if (content.trim()) chapters.push({ title: heading, content });
				i += 2;
			}
		}
	}

	if (chapters.length === 0) {
		addMessage('assistant', 'No chapters found in the file.');
		return;
	}

	// Process each chapter
	const chapterSections: string[] = [];
	const toc: string[] = [];

	for (let i = 0; i < chapters.length; i++) {
		const chapter = chapters[i]!;
		replaceMessage('assistant', `Processing chapter ${i + 1} of ${chapters.length}: **${chapter.title}**…`);

		let result: ChapterResult;
		try {
			result = await callOllamaStructured<ChapterResult>({
				model,
				ollamaUrl: config.ollamaUrl,
				messages: [{ role: 'user', content: Prompts.ingestChapter(chapter.title, chapter.content) }],
				format: CHAPTER_SCHEMA,
			});
		} catch {
			result = { summary: '_Could not process this chapter._', claims: [], questions: [] };
		}

		const claimsBullets = result.claims.map(c => `- ${c}`).join('\n');
		const questionsNumbered = result.questions.map((q, n) => `${n + 1}. ${q}`).join('\n');

		const section = [
			`## ${chapter.title}`,
			'',
			result.summary,
			...(result.claims.length > 0 ? ['', '**Key claims:**', claimsBullets] : []),
			...(result.questions.length > 0 ? ['', '**Review questions:**', questionsNumbered] : []),
		].join('\n');

		chapterSections.push(section);
		toc.push(`- [[#${chapter.title}]]`);
	}

	// Build output note
	const baseName = sanitizeFilename(
		(filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Ingested') + '-Ingest'
	);

	const noteContent = [
		`---`,
		`type: ingest`,
		`created: ${today()}`,
		`source: "${filePath}"`,
		`---`,
		'',
		`# ${baseName}`,
		'',
		'## Table of Contents',
		toc.join('\n'),
		'',
		chapterSections.join('\n\n'),
	].join('\n');

	await ensureFolder(app, settings.booksFolder);
	const notePath = await deduplicatePath(app, `${settings.booksFolder}/${baseName}.md`);
	await app.vault.create(notePath, noteContent);

	replaceMessage('assistant', `Ingested **${chapters.length}** chapter(s). Note saved to [[${notePath}]].`);
}

// ── /transcribe ───────────────────────────────────────────────────────────
// The Vizier server has no audio transcription route yet, so the command says
// so up front rather than posting to a route that does not exist.

export async function executeTranscribe(
	args: string,
	_app: App,
	addMessage: AddMessage,
	_replaceMessage: ReplaceMessage,
	_model: string,
	_config: CommandConfig,
	_settings: AIAgentSettings,
): Promise<void> {
	if (!args.trim()) {
		addMessage('assistant', 'Usage: `/transcribe <vault file path or URL>`');
		return;
	}
	addMessage('assistant', 'Audio transcription is not available in this version of Vizier. For a YouTube video, `/summarize <url>` or `/clip <url>` works from its transcript.');
}
