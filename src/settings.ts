import { App, PluginSettingTab, Setting } from 'obsidian';
import VizierPlugin from './main';
import { setDebugLogging } from './debug_log';
import { COMMAND_CATEGORIES, DEFAULT_COMMAND_MODULES, type ToggleableCategory } from './commands/categories';

// ── Role-based model routing ───────────────────────────────────────────────

export type ModelRole = 'default' | 'utility' | 'research' | 'embedding';

export interface RoleSettings {
	/** Ordered fallback chain: first available/responsive model wins. */
	models: string[];
	/** Override the global Ollama URL for this role only. */
	endpoint?: string;
}

// ── Feature flags ──────────────────────────────────────────────────────────

export interface FeatureFlags {
	/** Replace plain chat with the multi-round agent loop. */
	agentLoop: boolean;
	/** Post-turn memory extraction and retrieval. */
	memory: boolean;
	/** Daily RSS/feed intake pipeline. */
	intake: boolean;
	/** Daily briefing generation. */
	briefing: boolean;
	/** Verbose conversation-flow logging to vizier_debug.log for analysis. */
	debugLog: boolean;
	/** Auto-start the local Vizier server (transcripts, Wikipedia, OCR) with Obsidian, if setup was done. */
	autoStartServer: boolean;
}

// ── Main settings interface ────────────────────────────────────────────────

export interface AIAgentSettings {
	// ── Existing fields (unchanged) ──────────────────────────────────
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
	/** num_ctx for LOCAL Ollama models (cloud models always use their full window). 0 = use the model's max. */
	localContextWindow: number;
	whisperModel: string;
	timelineFolders: string;
	entitiesFolder: string;

	// ── New: role-based model routing ────────────────────────────────
	roles: {
		/** Chat, /write, /edit, agent loop turns. */
		default: RoleSettings;
		/** Metadata, tagging, dedup, memory extraction — use the fastest model. */
		utility: RoleSettings;
		/** /thesis, /clip long, deep synthesis — use the largest available model. */
		research: RoleSettings;
		/** All vector operations — should be an embedding-specific model. */
		embedding: RoleSettings;
	};

	// ── New: feature flags ────────────────────────────────────────────
	features: FeatureFlags;

	// ── New: per-group command toggles ────────────────────────────────
	/** Switch whole command groups off to declutter the slash picker. Core is always on. */
	commandModules: Record<ToggleableCategory, boolean>;

	// ── New: folder for Vizier-managed data notes ─────────────────────
	/** Inbox folder where autonomous writes land (briefings, contradiction flags, etc.) */
	inboxFolder: string;
	/** Folder where contradiction flags are written. */
	contradictionsFolder: string;
	/** Folder where skills are stored. */
	skillsFolder: string;

	// ── New: intake (Phase 4) ─────────────────────────────────────────
	/** RSS/Atom feed URLs, one per line (or comma-separated). */
	feedUrls: string;
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
	localContextWindow: 8192,
	whisperModel: 'base',
	timelineFolders: 'Human Network/Events, Human Network/People, Human Network/Ideas',
	entitiesFolder: 'Human Network/Entities',

	roles: {
		default:   { models: ['gemma4:e2b', 'gemma4:e4b'] },
		utility:   { models: ['gemma4:e2b', 'gemma3:4b'] },
		research:  { models: ['gemma4:12b', 'gemma4:e4b'] },
		embedding: { models: ['all-minilm:l6-v2', 'nomic-embed-text'] },
	},

	features: {
		agentLoop: true,
		memory:    true,
		intake:    false,
		briefing:  false,
		debugLog:  false,
		autoStartServer: true,
	},

	commandModules: { ...DEFAULT_COMMAND_MODULES },

	inboxFolder:         'Vizier/Inbox',
	contradictionsFolder:'Vizier/Contradictions',
	skillsFolder:        'Vizier/Skills',

	feedUrls: '',
};

// Role chains shipped before the gemma4 era. If a saved settings file still
// holds exactly these (i.e. the user never customised them), upgrade to the
// current defaults so the plugin doesn't call models that aren't installed.
const LEGACY_ROLE_DEFAULTS: Record<ModelRole, string[]> = {
	default:   ['gemma3:12b', 'gemma3:4b'],
	utility:   ['gemma3:4b'],
	research:  ['gemma3:27b', 'gemma3:12b', 'gemma3:4b'],
	embedding: ['nomic-embed-text', 'all-minilm'],
};

export function migrateLegacyRoleDefaults(roles: AIAgentSettings['roles']): boolean {
	let changed = false;
	for (const role of ['default', 'utility', 'research', 'embedding'] as const) {
		if (JSON.stringify(roles[role]?.models) === JSON.stringify(LEGACY_ROLE_DEFAULTS[role])) {
			roles[role] = { ...roles[role], models: [...DEFAULT_SETTINGS.roles[role].models] };
			changed = true;
		}
	}
	return changed;
}

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
			.setName('Local model context window (num_ctx)')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Context size for local Ollama models. Larger means more context but more memory. Cloud models (names ending in -cloud) always use their full window and ignore this. 0 = use the model\'s maximum.')
			.addText(text => text
				.setPlaceholder('8192')
				.setValue(String(this.plugin.settings.localContextWindow))
				.onChange(async (value) => {
					const n = parseInt(value.trim(), 10);
					this.plugin.settings.localContextWindow = isNaN(n) || n < 0 ? DEFAULT_SETTINGS.localContextWindow : n;
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

		new Setting(containerEl).setName("Clips").setHeading();

		new Setting(containerEl)
			.setName('Extract entities after clipping')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('After /clip, show a modal to link or create Human Network entities mentioned in the article.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.extractEntitiesAfterClip)
				.onChange(async (value) => {
					this.plugin.settings.extractEntitiesAfterClip = value;
					await this.plugin.saveSettings();
				}));

		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Setting(containerEl).setName("Human Network").setHeading();

		new Setting(containerEl)
			.setName('People folder')
			.setDesc('Vault folder where /person saves person notes.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
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
				// eslint-disable-next-line obsidianmd/ui/sentence-case
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
				// eslint-disable-next-line obsidianmd/ui/sentence-case
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
				// eslint-disable-next-line obsidianmd/ui/sentence-case
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
				// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setPlaceholder('Human Network/Events, Human Network/People, Human Network/Ideas')
				.setValue(this.plugin.settings.timelineFolders)
				.onChange(async (value) => {
					this.plugin.settings.timelineFolders = value.trim() || DEFAULT_SETTINGS.timelineFolders;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Reflection").setHeading();

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

		new Setting(containerEl).setName("Ingestion").setHeading();

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
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('base')
				.setValue(this.plugin.settings.whisperModel)
				.onChange(async (value) => {
					this.plugin.settings.whisperModel = value.trim() || DEFAULT_SETTINGS.whisperModel;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName("Research").setHeading();

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

		// ── Model roles ────────────────────────────────────────────────────

		new Setting(containerEl).setName('Model roles').setHeading();

		new Setting(containerEl)
			.setName('Default role models')
			.setDesc('Comma-separated fallback chain for chat, /write, and agent loop turns. First available model is used.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('gemma3:12b, gemma3:4b')
				.setValue(this.plugin.settings.roles.default.models.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.roles.default.models = value.split(',').map(m => m.trim()).filter(Boolean);
					if (this.plugin.settings.roles.default.models.length === 0)
						this.plugin.settings.roles.default.models = DEFAULT_SETTINGS.roles.default.models;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Utility role models')
			.setDesc('Fast model(s) for tagging, metadata extraction, memory dedup. Should be the smallest capable model.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('gemma3:4b')
				.setValue(this.plugin.settings.roles.utility.models.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.roles.utility.models = value.split(',').map(m => m.trim()).filter(Boolean);
					if (this.plugin.settings.roles.utility.models.length === 0)
						this.plugin.settings.roles.utility.models = DEFAULT_SETTINGS.roles.utility.models;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Research role models')
			.setDesc('Largest available model(s) for /thesis, deep synthesis, and gap analysis.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('gemma3:27b, gemma3:12b')
				.setValue(this.plugin.settings.roles.research.models.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.roles.research.models = value.split(',').map(m => m.trim()).filter(Boolean);
					if (this.plugin.settings.roles.research.models.length === 0)
						this.plugin.settings.roles.research.models = DEFAULT_SETTINGS.roles.research.models;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Embedding role models')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Embedding model for vector operations (vault index, memory retrieval). Must support /api/embeddings.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('nomic-embed-text')
				.setValue(this.plugin.settings.roles.embedding.models.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.roles.embedding.models = value.split(',').map(m => m.trim()).filter(Boolean);
					if (this.plugin.settings.roles.embedding.models.length === 0)
						this.plugin.settings.roles.embedding.models = DEFAULT_SETTINGS.roles.embedding.models;
					await this.plugin.saveSettings();
				}));

		// ── Features ───────────────────────────────────────────────────────

		new Setting(containerEl).setName('Features').setHeading();

		new Setting(containerEl)
			.setName('Agent loop')
			.setDesc('Replace plain chat with the multi-round agent that can use vault tools. Disable to revert to simple streaming chat.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.agentLoop)
				.onChange(async (v) => { this.plugin.settings.features.agentLoop = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Memory')
			.setDesc('Extract durable facts from conversations and surface them in future sessions.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.memory)
				.onChange(async (v) => { this.plugin.settings.features.memory = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Daily intake')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Triage configured RSS/Atom feeds against your interests on a daily schedule.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.intake)
				.onChange(async (v) => { this.plugin.settings.features.intake = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Daily briefing')
			.setDesc('Generate a morning briefing note from intake, recent activity, and open contradictions.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.briefing)
				.onChange(async (v) => { this.plugin.settings.features.briefing = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('Auto-start Vizier server')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Start the local Python helper server (YouTube transcripts, Wikipedia lookups, OCR) together with Obsidian, and on demand when a feature needs it. Only applies after the one-time server setup has been run.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.autoStartServer ?? true)
				.onChange(async (v) => { this.plugin.settings.features.autoStartServer = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Record detailed conversation flow — system prompt, each round\'s tool decisions, tool results, verifier verdict, final response, and errors — to vizier_debug.log in the plugin folder. For analysis; off by default.')
			.addToggle(t => t
				.setValue(this.plugin.settings.features.debugLog ?? false)
				.onChange(async (v) => {
					this.plugin.settings.features.debugLog = v;
					setDebugLogging(v);
					await this.plugin.saveSettings();
				}));

		// ── Command groups ─────────────────────────────────────────────
		new Setting(containerEl).setName('Command groups').setHeading();
		containerEl.createEl('p', {
			text: 'Switch whole groups of slash commands off to declutter the chat picker. The core group (write, edit, find, read) is always available. Disabled commands fall through to the agent as normal text.',
			cls: 'setting-item-description',
		});

		if (!this.plugin.settings.commandModules) {
			this.plugin.settings.commandModules = { ...DEFAULT_COMMAND_MODULES };
		}
		for (const cat of COMMAND_CATEGORIES) {
			new Setting(containerEl)
				.setName(cat.label)
				.setDesc(cat.desc)
				.addToggle(t => t
					.setValue(this.plugin.settings.commandModules[cat.id] !== false)
					.onChange(async (v) => {
						this.plugin.settings.commandModules[cat.id] = v;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('Feed URLs')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('RSS/Atom feed URLs for /intake — one per line.')
			.addTextArea(text => text
				.setPlaceholder('https://example.com/feed.xml')
				.setValue(this.plugin.settings.feedUrls)
				.onChange(async (value) => {
					this.plugin.settings.feedUrls = value;
					await this.plugin.saveSettings();
				}));

		// ── Vizier data folders ────────────────────────────────────────────

		// eslint-disable-next-line obsidianmd/settings-tab/no-problematic-settings-headings
		new Setting(containerEl).setName('Vizier data folders').setHeading();

		new Setting(containerEl)
			.setName('Inbox folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('Where Vizier writes autonomous outputs (briefings, drafted notes, etc.).')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('Vizier/Inbox')
				.setValue(this.plugin.settings.inboxFolder)
				.onChange(async (value) => {
					this.plugin.settings.inboxFolder = value.trim() || DEFAULT_SETTINGS.inboxFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Contradictions folder')
			.setDesc('Where contradiction flags are written by the background contradiction engine.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('Vizier/Contradictions')
				.setValue(this.plugin.settings.contradictionsFolder)
				.onChange(async (value) => {
					this.plugin.settings.contradictionsFolder = value.trim() || DEFAULT_SETTINGS.contradictionsFolder;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Skills folder')
			.setDesc('Where distilled research procedure skills are stored.')
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder('Vizier/Skills')
				.setValue(this.plugin.settings.skillsFolder)
				.onChange(async (value) => {
					this.plugin.settings.skillsFolder = value.trim() || DEFAULT_SETTINGS.skillsFolder;
					await this.plugin.saveSettings();
				}));
	}
}
