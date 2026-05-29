import { App, Notice, requestUrl } from 'obsidian';
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

interface TranscriptSegment {
	start: number;
	text: string;
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

	if (filePath.endsWith('.pdf')) {
		// PDF: requires Vizier server
		addMessage('assistant', `Ingesting **${filePath}**… (requires Vizier server — run "Setup / start Vizier server" from the command palette if this fails)`);
		try {
			const resp = await requestUrl({
				url: `${config.serverUrl}/extract_pdf`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: filePath }),
				throw: false,
			});
			if (resp.status >= 400) throw new Error(`Server error: HTTP ${resp.status}`);
			const data = resp.json as { chapters?: ServerChapter[] };
			chapters = data.chapters ?? [];
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			addMessage('assistant', `Failed to extract PDF: ${msg}`);
			return;
		}
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

function formatTimestamp(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function executeTranscribe(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const input = args.trim();
	if (!input) {
		addMessage('assistant', 'Usage: `/transcribe <vault file path or URL>`');
		return;
	}

	addMessage('assistant', `Transcribing **${input}**… (requires Vizier server with Whisper installed — run "Setup / start Vizier server" from the command palette if this fails. This may take several minutes.`);

	let segments: TranscriptSegment[];

	try {
		const resp = await requestUrl({
			url: `${config.serverUrl}/transcribe`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path_or_url: input, model: settings.whisperModel }),
			throw: false,
		});
		if (resp.status >= 400) {
			throw new Error((resp.json as { error?: string })?.error ?? `HTTP ${resp.status}`);
		}
		const data = resp.json as { segments?: TranscriptSegment[] };
		segments = data.segments ?? [];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		addMessage('assistant', `Transcription failed: ${msg}`);
		return;
	}

	if (segments.length === 0) {
		addMessage('assistant', 'Transcription returned no segments.');
		return;
	}

	// Group segments into ~60-second blocks
	const blocks: { heading: string; lines: string[] }[] = [];
	let currentBlock: { heading: string; lines: string[] } | null = null;
	let blockStart = 0;

	for (const seg of segments) {
		if (!currentBlock || seg.start - blockStart >= 60) {
			currentBlock = { heading: formatTimestamp(seg.start), lines: [] };
			blocks.push(currentBlock);
			blockStart = seg.start;
		}
		currentBlock.lines.push(seg.text.trim());
	}

	// Build note content
	const title = input.includes('/')
		? input.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Transcript'
		: input.replace(/^https?:\/\//, '').slice(0, 40);

	const noteLines: string[] = [
		`---`,
		`type: transcript`,
		`created: ${today()}`,
		`source: "${input}"`,
		`---`,
		'',
		`# ${title}`,
		'',
	];

	for (const block of blocks) {
		noteLines.push(`## ${block.heading}`);
		noteLines.push('');
		noteLines.push(block.lines.join(' '));
		noteLines.push('');
	}

	const noteContent = noteLines.join('\n');

	await ensureFolder(app, settings.transcriptsFolder);
	const fileName = sanitizeFilename(`${today()} - ${title}`);
	const notePath = await deduplicatePath(app, `${settings.transcriptsFolder}/${fileName}.md`);
	await app.vault.create(notePath, noteContent);

	const wordCount = segments.reduce((n, s) => n + s.text.split(' ').length, 0);
	replaceMessage(
		'assistant',
		`Transcript saved to [[${notePath}]] (~${wordCount} words).\n\nSend \`/clip learn ${notePath}\` to generate a study guide from the transcript.`
	);

	new Notice(`Transcript saved: ${notePath}`);

	// Open the note
	const file = app.vault.getAbstractFileByPath(notePath);
	if (file && 'stat' in file) {
		const leaf = app.workspace.getLeaf();
		await leaf.openFile(file as Parameters<typeof leaf.openFile>[0]);
	}
}
