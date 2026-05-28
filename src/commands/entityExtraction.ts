import { App, Modal, TFile } from 'obsidian';
import { callOllamaStructured } from '../utils/ollama';
import { Prompts } from '../prompts';
import { AIAgentSettings } from '../settings';
import { CommandConfig, AddMessage } from './slashCommands';
import { findEntityByName } from '../utils/vaultQuery';
import { executeCreatePerson, executeCreateEvent, executeCreateIdea } from './humanNetworkCommands';

// ── Types ─────────────────────────────────────────────────────────────────

interface EntityCandidate {
	name: string;
	context: string;
	existingFile: TFile | null;
	type: 'person' | 'event' | 'idea';
	action: 'link' | 'create' | 'skip';
}

interface ExtractedEntities {
	people: Array<{ name: string; context: string }>;
	events: Array<{ name: string; context: string }>;
	ideas: Array<{ name: string; context: string }>;
}

const EXTRACT_SCHEMA = {
	type: 'object',
	properties: {
		people: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, context: { type: 'string' } }, required: ['name', 'context'] } },
		events: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, context: { type: 'string' } }, required: ['name', 'context'] } },
		ideas: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, context: { type: 'string' } }, required: ['name', 'context'] } },
	},
	required: ['people', 'events', 'ideas'],
};

// ── Modal ─────────────────────────────────────────────────────────────────

class EntityExtractionModal extends Modal {
	private candidates: EntityCandidate[];
	private onConfirm: (candidates: EntityCandidate[]) => void;

	constructor(app: App, candidates: EntityCandidate[], onConfirm: (candidates: EntityCandidate[]) => void) {
		super(app);
		this.candidates = candidates;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Entities found in clip' });
		contentEl.createEl('p', { text: 'Select how to handle each entity in your Human Network.' });

		const groups: Record<string, EntityCandidate[]> = { People: [], Events: [], Ideas: [] };
		for (const c of this.candidates) {
			const key = c.type === 'person' ? 'People' : c.type === 'event' ? 'Events' : 'Ideas';
			groups[key]!.push(c);
		}

		for (const [groupName, items] of Object.entries(groups)) {
			if (items.length === 0) continue;
			contentEl.createEl('h3', { text: groupName });

			for (const candidate of items) {
				const row = contentEl.createDiv({ cls: 'vizier-entity-row' });
				const left = row.createDiv({ cls: 'vizier-entity-info' });
				left.createEl('strong', { text: candidate.name });
				left.createEl('span', { text: ` — ${candidate.context}`, cls: 'vizier-entity-context' });
				if (candidate.existingFile) {
					left.createEl('span', { text: ' (exists)', cls: 'vizier-entity-exists' });
				}

				const select = row.createEl('select', { cls: 'vizier-entity-action' });
				const options: Array<{ value: EntityCandidate['action']; label: string }> = [
					{ value: 'link', label: candidate.existingFile ? 'Link' : 'Link (will create)' },
					{ value: 'create', label: 'Create note' },
					{ value: 'skip', label: 'Skip' },
				];
				for (const opt of options) {
					const el = select.createEl('option', { text: opt.label, value: opt.value });
					if (opt.value === (candidate.existingFile ? 'link' : 'skip')) el.selected = true;
				}
				select.onchange = () => { candidate.action = select.value as EntityCandidate['action']; };
				// Set initial action to match default selection
				candidate.action = candidate.existingFile ? 'link' : 'skip';
			}
		}

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const confirmBtn = btnRow.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

		confirmBtn.onclick = () => { this.onConfirm(this.candidates); this.close(); };
		cancelBtn.onclick = () => this.close();
	}

	onClose(): void { this.contentEl.empty(); }
}

// ── Main export ───────────────────────────────────────────────────────────

export async function runEntityExtraction(
	summary: string,
	clipFilePath: string,
	app: App,
	addMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	if (!settings.extractEntitiesAfterClip) return;

	let extracted: ExtractedEntities;
	try {
		extracted = await callOllamaStructured<ExtractedEntities>({
			model, ollamaUrl: config.ollamaUrl,
			messages: [{ role: 'user', content: Prompts.extractEntities(summary) }],
			format: EXTRACT_SCHEMA,
		});
	} catch { return; }

	const entityFolders = [settings.peopleFolder, settings.eventsFolder, settings.ideasFolder];

	const candidates: EntityCandidate[] = [
		...(extracted.people ?? []).map(e => ({ ...e, type: 'person' as const, existingFile: findEntityByName(app, e.name, entityFolders), action: 'skip' as const })),
		...(extracted.events ?? []).map(e => ({ ...e, type: 'event' as const, existingFile: findEntityByName(app, e.name, entityFolders), action: 'skip' as const })),
		...(extracted.ideas ?? []).map(e => ({ ...e, type: 'idea' as const, existingFile: findEntityByName(app, e.name, entityFolders), action: 'skip' as const })),
	].filter(c => c.name.trim().length > 0);

	if (candidates.length === 0) return;

	await new Promise<void>(resolve => {
		new EntityExtractionModal(app, candidates, async (confirmed) => {
			await applyEntityActions(confirmed, clipFilePath, app, addMessage, model, config, settings);
			resolve();
		}).open();
	});
}

async function applyEntityActions(
	candidates: EntityCandidate[],
	clipFilePath: string,
	app: App,
	addMessage: AddMessage,
	model: string,
	config: CommandConfig,
	settings: AIAgentSettings,
): Promise<void> {
	const linkedNames: string[] = [];

	for (const candidate of candidates) {
		if (candidate.action === 'skip') continue;

		if (candidate.action === 'create' || (candidate.action === 'link' && !candidate.existingFile)) {
			// Create the entity note first
			const noop: AddMessage = () => undefined;
			const cmdConfig: CommandConfig = { ollamaUrl: config.ollamaUrl, serverUrl: config.serverUrl };
			try {
				if (candidate.type === 'person') {
					await executeCreatePerson(candidate.name, app, noop, noop, model, cmdConfig, settings);
				} else if (candidate.type === 'event') {
					await executeCreateEvent(candidate.name, app, noop, noop, model, cmdConfig, settings);
				} else {
					await executeCreateIdea(candidate.name, app, noop, noop, model, cmdConfig, settings);
				}
			} catch { /* continue */ }
		}

		linkedNames.push(candidate.name);
	}

	if (linkedNames.length === 0) return;

	// Append ## Related section to clip note
	const clipFile = app.vault.getAbstractFileByPath(clipFilePath);
	if (!(clipFile instanceof TFile)) return;

	const content = await app.vault.read(clipFile);
	const links = linkedNames.map(n => `[[${n}]]`).join(', ');
	const appendText = content.includes('## Related')
		? '' // already has a Related section
		: `\n\n## Related\n${links}`;

	if (appendText) {
		await app.vault.modify(clipFile, content + appendText);
	}

	addMessage('assistant', `Linked ${linkedNames.map(n => `[[${n}]]`).join(', ')} to clip note.`);
}
