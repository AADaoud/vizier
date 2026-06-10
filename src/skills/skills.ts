/**
 * skills/skills.ts
 *
 * Skill distillation and retrieval — Phase 5.1.
 *
 * A skill is a reusable procedure learned from a successful multi-round agent
 * session, stored as a markdown note in the skills folder:
 *
 *   ---
 *   type: skill
 *   keywords: [research, entity]
 *   confidence: 0.8
 *   uses: 3
 *   ---
 *   ## When to use
 *   ## Procedure
 *   ## Pitfalls
 *
 * Distillation runs in the background after qualifying sessions (≥2 rounds,
 * ≥2 tools, run ok). Retrieval is keyword-based like tool selection, and the
 * matched procedures are injected into the system prompt as a skills block.
 */

import type { App, TFile } from 'obsidian';
import { buildLLMConfig, callStructured } from '../llm_core';
import { SkillDraftSchema, type SkillDraft } from '../schemas/index';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';
import { ensureFolder, sanitizeFilename, deduplicatePath } from '../utils/noteBuilder';

const MIN_CONFIDENCE = 0.6;
const MAX_SKILLS_IN_PROMPT = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoredSkill {
	title: string;
	when_to_use: string;
	procedure: string;
	pitfalls: string;
	keywords: string[];
	file: TFile;
}

// ── Loading ────────────────────────────────────────────────────────────────

function sectionOf(content: string, heading: string): string {
	const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
	return re.exec(content)?.[1]?.trim() ?? '';
}

export async function loadSkills(app: App, settings: AIAgentSettings): Promise<StoredSkill[]> {
	const folder = settings.skillsFolder || 'Vizier/Skills';
	const files = app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder + '/'));
	const skills: StoredSkill[] = [];

	for (const file of files) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm?.['type'] !== 'skill') continue;
		try {
			const content = await app.vault.cachedRead(file);
			const kw = fm['keywords'] as string[] | string | undefined;
			skills.push({
				title: file.basename,
				when_to_use: sectionOf(content, 'When to use'),
				procedure: sectionOf(content, 'Procedure'),
				pitfalls: sectionOf(content, 'Pitfalls'),
				keywords: Array.isArray(kw) ? kw : typeof kw === 'string' ? [kw] : [],
				file,
			});
		} catch { /* unreadable — skip */ }
	}
	return skills;
}

// ── Selection ──────────────────────────────────────────────────────────────

export function selectSkills(skills: StoredSkill[], recentUserMessages: string[]): StoredSkill[] {
	const combined = recentUserMessages.slice(-3).join(' ').toLowerCase();
	return skills
		.filter(s =>
			s.keywords.some(kw => combined.includes(kw.toLowerCase())) ||
			combined.includes(s.title.toLowerCase())
		)
		.slice(0, MAX_SKILLS_IN_PROMPT);
}

export function formatSkillsBlock(skills: StoredSkill[]): string {
	return skills.map(s => [
		`### Skill: ${s.title}`,
		s.when_to_use ? `When: ${s.when_to_use}` : '',
		`Procedure:\n${s.procedure}`,
		s.pitfalls ? `Pitfalls: ${s.pitfalls}` : '',
	].filter(Boolean).join('\n')).join('\n\n');
}

// ── Distillation ───────────────────────────────────────────────────────────

/**
 * Distil a reusable skill from a finished multi-round session transcript.
 * Fire-and-forget: never throws, never blocks the chat.
 */
export async function distillSkill(
	app: App,
	settings: AIAgentSettings,
	transcript: string,
	toolsUsed: string[]
): Promise<string | null> {
	const start = Date.now();
	const cfg = buildLLMConfig(settings);

	try {
		const draft = await callStructured<SkillDraft>(
			cfg, 'utility',
			SkillDraftSchema as Record<string, unknown>,
			[{
				role: 'user',
				content: [
					'Below is a transcript of a successful multi-step agent session in a personal knowledge vault.',
					'If it demonstrates a REUSABLE procedure (a sequence of tool calls and decisions that would apply to similar future requests), distil it into a skill.',
					'If the session was one-off or trivial, set confidence below 0.5.',
					`Tools used: ${toolsUsed.join(', ')}`,
					'',
					'Transcript:',
					transcript.slice(0, 8000),
				].join('\n'),
			}]
		);

		if (!draft.title || draft.confidence < MIN_CONFIDENCE) {
			recordRun({ kind: 'skill', duration_ms: Date.now() - start, ok: true, notes_touched: 0 });
			return null;
		}

		// Dedupe: skip if a skill with a very similar title already exists
		const existing = await loadSkills(app, settings);
		const titleLower = draft.title.toLowerCase();
		if (existing.some(s => s.title.toLowerCase() === titleLower)) {
			recordRun({ kind: 'skill', duration_ms: Date.now() - start, ok: true, notes_touched: 0 });
			return null;
		}

		const folder = settings.skillsFolder || 'Vizier/Skills';
		await ensureFolder(app, folder);
		const notePath = await deduplicatePath(app, `${folder}/${sanitizeFilename(draft.title)}`);

		const keywords = [...new Set(toolsUsed.concat(draft.title.toLowerCase().split(/\s+/).filter(w => w.length > 3)))];

		await app.vault.create(notePath, [
			'---',
			'type: skill',
			`keywords: [${keywords.join(', ')}]`,
			`confidence: ${draft.confidence}`,
			'uses: 0',
			`created: ${new Date().toISOString().slice(0, 10)}`,
			'---',
			'',
			`# ${draft.title}`,
			'',
			'## When to use',
			'',
			draft.when_to_use,
			'',
			'## Procedure',
			'',
			draft.procedure,
			'',
			'## Pitfalls',
			'',
			draft.pitfalls || '(none recorded)',
			'',
		].join('\n'));

		recordRun({ kind: 'skill', duration_ms: Date.now() - start, ok: true, notes_touched: 1 });
		return notePath;
	} catch (err) {
		recordRun({ kind: 'skill', duration_ms: Date.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
