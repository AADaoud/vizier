import { App, PluginSettingTab, Setting } from 'obsidian';
import VizierPlugin from './main';

export interface AIAgentSettings {
	ollamaUrl: string;
	defaultModel: string;
	serverUrl: string;
	clipsFolder: string;
	aiNotesFolder: string;
	handwritingFolder: string;
	peopleFolder: string;
	eventsFolder: string;
	ideasFolder: string;
	extractEntitiesAfterClip: boolean;
	reflectionsFolder: string;
	booksFolder: string;
	transcriptsFolder: string;
	thesesFolder: string;
	reclusterMaxNotes: number;
	whisperModel: string;
	timelineFolders: string;
	entitiesFolder: string;
}

export const DEFAULT_SETTINGS: AIAgentSettings = {
	ollamaUrl: 'http://localhost:11434',
	defaultModel: 'gemma3:4b',
	serverUrl: 'http://127.0.0.1:11435',
	clipsFolder: 'Clips',
	aiNotesFolder: '',
	handwritingFolder: 'Handwritten Notes',
	peopleFolder: 'Human Network/People',
	eventsFolder: 'Human Network/Events',
	ideasFolder: 'Human Network/Ideas',
	extractEntitiesAfterClip: true,
	reflectionsFolder: 'Reflections',
	booksFolder: 'Books',
	transcriptsFolder: 'Transcripts',
	thesesFolder: 'Theses',
	reclusterMaxNotes: 100,
	whisperModel: 'base',
	timelineFolders: 'Human Network/Events, Human Network/People, Human Network/Ideas',
	entitiesFolder: 'Human Network/Entities',
};

export class AIAgentSettingTab extends PluginSettingTab {
	plugin: VizierPlugin;

	constructor(app: App, plugin: VizierPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Ollama URL')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Base URL of your Ollama instance.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaUrl)
				.onChange(async (value) => {
					this.plugin.settings.ollamaUrl = value.trim() || DEFAULT_SETTINGS.ollamaUrl;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default model')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Ollama model name used by default (e.g. gemma3:4b, llama3.2).')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('gemma3:4b')
				.setValue(this.plugin.settings.defaultModel)
				.onChange(async (value) => {
					this.plugin.settings.defaultModel = value.trim() || DEFAULT_SETTINGS.defaultModel;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vizier server URL')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Base URL of the local Vizier server (vizier_server.py). Provides YouTube transcripts and handwriting OCR.')
			.addText(text => text
				.setPlaceholder('http://127.0.0.1:11435')
				.setValue(this.plugin.settings.serverUrl)
				.onChange(async (value) => {
					this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Clips folder')
			.setDesc('Vault folder where /clip saves notes.')
			.addText(text => text
				.setPlaceholder('Clips')
				.setValue(this.plugin.settings.clipsFolder)
				.onChange(async (value) => {
					this.plugin.settings.clipsFolder = value.trim() || DEFAULT_SETTINGS.clipsFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('AI notes folder')
			.setDesc('Vault folder where /write saves AI-generated notes. Leave blank to use the default new-file location.')
			.addText(text => text
				.setPlaceholder('(default new-file location)')
				.setValue(this.plugin.settings.aiNotesFolder)
				.onChange(async (value) => {
					this.plugin.settings.aiNotesFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Handwritten notes folder')
			.setDesc('Vault folder where /handwriting saves transcribed notes.')
			.addText(text => text
				.setPlaceholder('Handwritten notes')
				.setValue(this.plugin.settings.handwritingFolder)
				.onChange(async (value) => {
					this.plugin.settings.handwritingFolder = value.trim() || DEFAULT_SETTINGS.handwritingFolder;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Clips' });

		new Setting(containerEl)
			.setName('Extract entities after clipping')
			.setDesc('After /clip, show a modal to link or create Human Network entities mentioned in the article.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.extractEntitiesAfterClip)
				.onChange(async (value) => {
					this.plugin.settings.extractEntitiesAfterClip = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Human Network' });

		new Setting(containerEl)
			.setName('People folder')
			.setDesc('Vault folder where /person saves person notes.')
			.addText(text => text
				.setPlaceholder('Human Network/People')
				.setValue(this.plugin.settings.peopleFolder)
				.onChange(async (value) => {
					this.plugin.settings.peopleFolder = value.trim() || DEFAULT_SETTINGS.peopleFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Events folder')
			.setDesc('Vault folder where /event saves event notes.')
			.addText(text => text
				.setPlaceholder('Human Network/Events')
				.setValue(this.plugin.settings.eventsFolder)
				.onChange(async (value) => {
					this.plugin.settings.eventsFolder = value.trim() || DEFAULT_SETTINGS.eventsFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ideas folder')
			.setDesc('Vault folder where /idea saves concept notes.')
			.addText(text => text
				.setPlaceholder('Human Network/Ideas')
				.setValue(this.plugin.settings.ideasFolder)
				.onChange(async (value) => {
					this.plugin.settings.ideasFolder = value.trim() || DEFAULT_SETTINGS.ideasFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Entities folder')
			.setDesc('Vault folder where /entity saves generic entity notes (organizations, places, movements, etc.).')
			.addText(text => text
				.setPlaceholder('Human Network/Entities')
				.setValue(this.plugin.settings.entitiesFolder)
				.onChange(async (value) => {
					this.plugin.settings.entitiesFolder = value.trim() || DEFAULT_SETTINGS.entitiesFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Timeline folders')
			.setDesc('Comma-separated vault folders /timeline searches. Add any folder whose notes have a date: field.')
			.addText(text => text
				.setPlaceholder('Human Network/Events, Human Network/People, Human Network/Ideas')
				.setValue(this.plugin.settings.timelineFolders)
				.onChange(async (value) => {
					this.plugin.settings.timelineFolders = value.trim() || DEFAULT_SETTINGS.timelineFolders;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Reflection' });

		new Setting(containerEl)
			.setName('Reflections folder')
			.setDesc('Vault folder where /weekly, /monthly, and /freewrite save notes.')
			.addText(text => text
				.setPlaceholder('Reflections')
				.setValue(this.plugin.settings.reflectionsFolder)
				.onChange(async (value) => {
					this.plugin.settings.reflectionsFolder = value.trim() || DEFAULT_SETTINGS.reflectionsFolder;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Ingestion' });

		new Setting(containerEl)
			.setName('Books folder')
			.setDesc('Vault folder where /ingest saves processed book notes.')
			.addText(text => text
				.setPlaceholder('Books')
				.setValue(this.plugin.settings.booksFolder)
				.onChange(async (value) => {
					this.plugin.settings.booksFolder = value.trim() || DEFAULT_SETTINGS.booksFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Transcripts folder')
			.setDesc('Vault folder where /transcribe saves audio transcripts.')
			.addText(text => text
				.setPlaceholder('Transcripts')
				.setValue(this.plugin.settings.transcriptsFolder)
				.onChange(async (value) => {
					this.plugin.settings.transcriptsFolder = value.trim() || DEFAULT_SETTINGS.transcriptsFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Whisper model')
			.setDesc('Model size for audio transcription. Larger models are more accurate but slower (tiny / base / small / medium).')
			.addText(text => text
				.setPlaceholder('base')
				.setValue(this.plugin.settings.whisperModel)
				.onChange(async (value) => {
					this.plugin.settings.whisperModel = value.trim() || DEFAULT_SETTINGS.whisperModel;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Research' });

		new Setting(containerEl)
			.setName('Theses folder')
			.setDesc('Vault folder where /thesis saves structured view documents.')
			.addText(text => text
				.setPlaceholder('Theses')
				.setValue(this.plugin.settings.thesesFolder)
				.onChange(async (value) => {
					this.plugin.settings.thesesFolder = value.trim() || DEFAULT_SETTINGS.thesesFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max notes per recluster')
			.setDesc('Maximum number of notes /recluster will process (most recent by modification date).')
			.addText(text => text
				.setPlaceholder('100')
				.setValue(String(this.plugin.settings.reclusterMaxNotes))
				.onChange(async (value) => {
					const n = parseInt(value.trim());
					this.plugin.settings.reclusterMaxNotes = isNaN(n) || n < 1 ? DEFAULT_SETTINGS.reclusterMaxNotes : n;
					await this.plugin.saveSettings();
				}));
	}
}
