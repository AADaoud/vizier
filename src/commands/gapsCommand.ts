/**
 * commands/gapsCommand.ts
 *
 * /gaps — epistemic gap analysis (Phase 3.3).
 *
 * Surveys what the vault currently covers (tags, entities, recent titles),
 * then asks the research model what is conspicuously MISSING given those
 * interests: absent themes, entities worth creating, readings worth doing.
 *
 * Output: chat summary + a gap report note in the Vizier inbox.
 */

import type { App } from 'obsidian';
import { buildLLMConfig, callStructured } from '../llm_core';
import { GapReportSchema, type GapReport } from '../schemas/index';
import type { AIAgentSettings } from '../settings';
import { recordRun } from '../traces';
import { ensureFolder, sanitizeFilename, deduplicatePath } from '../utils/noteBuilder';

type AddMessage = (role: string, content: string) => void;

// ── Vault survey ───────────────────────────────────────────────────────────

function surveyVault(app: App, settings: AIAgentSettings): string {
	const files = app.vault.getMarkdownFiles();

	// Tag frequency
	const tagCounts = new Map<string, number>();
	for (const f of files) {
		const cache = app.metadataCache.getFileCache(f);
		const fmTags = cache?.frontmatter?.['tags'] as string[] | string | undefined;
		const list = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? [fmTags] : [];
		for (const t of list) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
		for (const t of cache?.tags ?? []) {
			const name = t.tag.replace(/^#/, '');
			tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
		}
	}
	const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
		.map(([t, n]) => `${t} (${n})`).join(', ');

	// Entity inventory
	const entityFolders = [settings.peopleFolder, settings.eventsFolder, settings.ideasFolder, settings.entitiesFolder].filter(Boolean);
	const entityNames: string[] = [];
	for (const folder of entityFolders) {
		for (const f of files) {
			if (f.path.startsWith(folder + '/')) entityNames.push(f.basename);
		}
	}

	// Recent work
	const recent = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 40)
		.map(f => f.basename).join('; ');

	return [
		`Total notes: ${files.length}`,
		`Top tags: ${topTags || '(none)'}`,
		`Entities (${entityNames.length}): ${entityNames.slice(0, 80).join('; ')}`,
		`Recently modified: ${recent}`,
	].join('\n');
}

// ── Command ────────────────────────────────────────────────────────────────

export async function executeGaps(
	args: string,
	app: App,
	addMessage: AddMessage,
	replaceMessage: AddMessage,
	settings: AIAgentSettings
): Promise<void> {
	const start = Date.now();
	addMessage('assistant', 'Surveying the vault and analyzing gaps…');

	const survey = surveyVault(app, settings);
	const focus  = args.trim();
	const cfg    = buildLLMConfig(settings);

	try {
		const report = await callStructured<GapReport>(
			cfg, 'research',
			GapReportSchema as Record<string, unknown>,
			[{
				role: 'user',
				content: [
					'You are analyzing a personal knowledge vault for epistemic gaps.',
					'Given the survey below, identify: (1) themes clearly present, (2) themes that are conspicuously ABSENT given the holder\'s evident interests — adjacent areas they would benefit from but have no notes on, (3) specific entities (people, events, concepts) worth creating notes for, and (4) concrete readings that would fill the biggest gaps.',
					focus ? `Focus the analysis on: ${focus}` : '',
					'Be specific — name actual thinkers, events, books. Avoid generic advice.',
					'',
					'Vault survey:',
					survey,
				].filter(Boolean).join('\n'),
			}]
		);

		const md = [
			`## Gap analysis${focus ? `: ${focus}` : ''}`,
			'',
			`**Present themes:** ${report.present_themes.join(', ')}`,
			'',
			`**Absent themes:**`,
			...report.absent_themes.map(t => `- ${t}`),
			'',
			`**Entities worth creating:**`,
			...report.recommended_entities.map(e => `- [[${e}]]`),
			...(report.recommended_readings?.length
				? ['', '**Recommended readings:**', ...report.recommended_readings.map(r => `- ${r}`)]
				: []),
			'',
			report.summary,
		].join('\n');

		// Persist to the inbox
		const folder = settings.inboxFolder || 'Vizier/Inbox';
		await ensureFolder(app, folder);
		const title = `Gap Report ${new Date().toISOString().slice(0, 10)}${focus ? ` - ${focus}` : ''}`;
		const notePath = await deduplicatePath(app, `${folder}/${sanitizeFilename(title)}`);
		await app.vault.create(notePath, [
			'---',
			'type: gap-report',
			`created: ${new Date().toISOString().slice(0, 10)}`,
			'---',
			'',
			md,
		].join('\n'));

		replaceMessage('assistant', `${md}\n\n*Saved to [[${title}]].*`);
		recordRun({ kind: 'gaps', duration_ms: Date.now() - start, ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		replaceMessage('assistant', `Gap analysis failed: ${msg}`);
		recordRun({ kind: 'gaps', duration_ms: Date.now() - start, ok: false, error: msg });
	}
}
