import { App } from 'obsidian';
import { callOllama, callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { CommandConfig, AddMessage, ReplaceMessage } from './slashCommands';
import { buildDateField } from '../utils/noteBuilder';

interface StandardizeTypeResult { type: string }
const STANDARDIZE_TYPE_SCHEMA = {
	type: 'object',
	properties: { type: { type: 'string', enum: ['clip', 'write', 'handwriting', 'person', 'event', 'idea'] } },
	required: ['type'],
};

/**
 * Splits raw file content into a frontmatter block and body.
 * Returns `{ fm, body, hasFm }` where `fm` is the text between the --- delimiters.
 */
function splitFrontmatter(content: string): { fm: string; body: string; hasFm: boolean } {
	if (!content.startsWith('---')) return { fm: '', body: content, hasFm: false };
	const end = content.indexOf('\n---', 3);
	if (end === -1) return { fm: '', body: content, hasFm: false };
	return {
		fm: content.slice(3, end).trim(),
		body: content.slice(end + 4),
		hasFm: true,
	};
}

/** Returns the value of a scalar frontmatter field, or null if absent. */
function getFmField(fm: string, key: string): string | null {
	const match = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
	return match ? (match[1] ?? '').trim() : null;
}

/** Returns true if a frontmatter tag list contains the given tag. */
function hasFmTag(fm: string, tag: string): boolean {
	return fm.includes(`- ${tag}`) || fm.includes(`- "${tag}"`);
}

/**
 * Infer the note type from frontmatter fields + tags without an AI call.
 * Returns null if inference is ambiguous (caller should fall back to AI).
 */
function inferTypeHeuristic(fm: string): string | null {
	if (getFmField(fm, 'source') || hasFmTag(fm, 'clip')) return 'clip';
	if (hasFmTag(fm, 'handwriting')) return 'handwriting';
	if (getFmField(fm, 'born') !== null || getFmField(fm, 'died') !== null) return 'person';
	if (getFmField(fm, 'domain') !== null || getFmField(fm, 'proponents') !== null) return 'idea';
	if (getFmField(fm, 'date') !== null && getFmField(fm, 'location') !== null) return 'event';
	if (hasFmTag(fm, 'ai')) return 'write';
	return null;
}

export async function executeStandardize(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: ReplaceMessage,
	model: string,
	config: CommandConfig,
): Promise<void> {
	const dir = args.trim().replace(/\/$/, '');
	if (!dir) {
		addMessage('assistant', 'Usage: `/standardize <directory>` — e.g. `/standardize Clips`');
		return;
	}

	const files = app.vault.getMarkdownFiles().filter(f => f.parent?.path === dir);
	if (files.length === 0) {
		addMessage('assistant', `No markdown files found in \`${dir}\`.`);
		return;
	}

	addMessage('assistant', `Standardizing ${files.length} notes in \`${dir}\`…`);

	let updated = 0;
	let ctimeFallbacks = 0;
	for (const file of files) {
		let content: string;
		try { content = await app.vault.read(file); } catch { continue; }

		const { fm, body, hasFm } = splitFrontmatter(content);

		// Skip if both fields already present
		const hasType = getFmField(fm, 'type') !== null;
		const hasCreated = getFmField(fm, 'created') !== null || getFmField(fm, 'date') !== null;
		if (hasType && hasCreated) continue;

		const additions: string[] = [];

		// Add type
		if (!hasType) {
			let type = inferTypeHeuristic(fm);
			if (!type) {
				// Fall back to AI inference
				try {
					const tags = (fm.match(/^ {2}- (.+)$/gm) ?? []).map(l => l.replace(/^ {2}- /, '').replace(/"/g, '').trim());
					const result = await callOllamaStructured<StandardizeTypeResult>({
						model,
						ollamaUrl: config.ollamaUrl,
						messages: [{ role: 'user', content: Prompts.standardizeType(content, tags) }],
						format: STANDARDIZE_TYPE_SCHEMA,
					});
					type = result.type;
				} catch {
					type = 'write';
				}
			}
			additions.push(`type: ${type}`);
		}

		// Add created — AI parses embedded timestamps in the body, with ctime as fallback context
		if (!hasCreated) {
			const ctimeIso = new Date(file.stat.ctime).toISOString().slice(0, 10);
			let isoDate = ctimeIso;
			let usedFallback = false;
			try {
				const raw = await callOllama({
					model,
					ollamaUrl: config.ollamaUrl,
					messages: [{ role: 'user', content: Prompts.parseCreatedDate(body || content, ctimeIso) }],
				});
				// Accept only a bare YYYY-MM-DD; discard anything that doesn't match
				const match = raw.trim().match(/^\d{4}-\d{2}-\d{2}$/);
				if (match) isoDate = raw.trim();
				else usedFallback = true;
			} catch { usedFallback = true; }
			if (usedFallback) ctimeFallbacks++;
			additions.push(`created: ${buildDateField(isoDate)}`);
		}

		if (additions.length === 0) continue;

		// Reconstruct: insert additions at top of frontmatter block
		let newContent: string;
		if (hasFm) {
			newContent = `---\n${additions.join('\n')}\n${fm}\n---${body}`;
		} else {
			// No frontmatter at all — prepend one
			newContent = `---\n${additions.join('\n')}\n---\n\n${content}`;
		}

		try {
			await app.vault.modify(file, newContent);
			updated++;
		} catch { /* skip */ }
	}

	const fallbackNote = ctimeFallbacks > 0
		? ` (${ctimeFallbacks} date(s) fell back to filesystem ctime — make sure Ollama is running for better results)`
		: '';
	replaceMessage('assistant', `Updated **${updated}** of **${files.length}** notes in \`${dir}\`.${fallbackNote}`);
}
