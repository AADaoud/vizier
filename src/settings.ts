import { App, PluginSettingTab, Setting } from 'obsidian';
import VizierPlugin from './main';

export interface AIAgentSettings {
	ollamaUrl: string;
	defaultModel: string;
	transcriptServerUrl: string;
	clipsFolder: string;
	aiNotesFolder: string;
	handwritingFolder: string;
}

export const DEFAULT_SETTINGS: AIAgentSettings = {
	ollamaUrl: 'http://localhost:11434',
	defaultModel: 'gemma3:4b',
	transcriptServerUrl: 'http://127.0.0.1:11435',
	clipsFolder: 'Clips',
	aiNotesFolder: '',
	handwritingFolder: 'Handwritten Notes',
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
			.setName('Transcript server URL')
			.setDesc('Base URL of the local YouTube transcript server (transcript_server.py).')
			.addText(text => text
				.setPlaceholder('http://127.0.0.1:11435')
				.setValue(this.plugin.settings.transcriptServerUrl)
				.onChange(async (value) => {
					this.plugin.settings.transcriptServerUrl = value.trim() || DEFAULT_SETTINGS.transcriptServerUrl;
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
				.setPlaceholder('Handwritten Notes')
				.setValue(this.plugin.settings.handwritingFolder)
				.onChange(async (value) => {
					this.plugin.settings.handwritingFolder = value.trim() || DEFAULT_SETTINGS.handwritingFolder;
					await this.plugin.saveSettings();
				}));
	}
}
