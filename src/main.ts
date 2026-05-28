import { App, Notice, Plugin } from 'obsidian';
import { AIAgentSettings, DEFAULT_SETTINGS, AIAgentSettingTab } from './settings';
import { ChatView, VIEW_TYPE_AI_CHAT } from './ui/ChatView';
import { TranscriptServerManager, ServerSetupModal } from './ui/ServerSetupModal';
import { executeWrite, executeEdit, executeClip, executeRead, CommandConfig, AddMessage } from './commands/slashCommands';
import { executeCreatePerson, executeCreateEvent, executeCreateIdea, executeLink } from './commands/humanNetworkCommands';
import { executeStandardize } from './commands/miscCommands';
import { executeSocratic, executeReflection, executeFreewrite, executeSources } from './commands/reflectionCommands';
import { promptModal } from './ui/PromptModal';
import { mapReduceSummarize } from './utils/chunking';

// ── Notice-based message helpers ───────────────────────────────────────────

function noticeCallbacks(): { addMessage: AddMessage; replaceMessage: AddMessage } {
	let current: Notice | null = null;
	const show = (_role: string, content: string) => {
		current?.hide();
		current = new Notice(content, 0);
	};
	return { addMessage: show, replaceMessage: show };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export default class VizierPlugin extends Plugin {
	settings: AIAgentSettings;
	serverManager: TranscriptServerManager;

	/** Pending command to inject into a newly opened chat view. */
	pendingChatCommand: string | null = null;

	async onload() {
		await this.loadSettings();

		this.serverManager = new TranscriptServerManager(this.app, this.manifest.dir ?? '');

		this.registerView(
			VIEW_TYPE_AI_CHAT,
			(leaf) => new ChatView(leaf, this.settings, this)
		);

		this.addRibbonIcon('chess-bishop', 'Vizier', () => {
			void this.activateChatView();
		});

		// ── Built-in: open chat ────────────────────────────────────────
		this.addCommand({
			id: 'open-ai-agent-chat',
			name: 'Chat',
			callback: () => { void this.activateChatView(); },
		});

		// ── Write note with AI ─────────────────────────────────────────
		this.addCommand({
			id: 'ai-write-note',
			name: 'Write note with AI',
			callback: async () => {
				const topic = await promptModal(this.app, 'Write note with AI', 'Describe the note topic…');
				if (!topic) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = {
					ollamaUrl: this.settings.ollamaUrl,
					serverUrl: this.settings.serverUrl,
				};
				await executeWrite(topic, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings.aiNotesFolder);
			},
		});

		// ── Clip active URL from clipboard ─────────────────────────────
		this.addCommand({
			id: 'ai-clip-url',
			name: 'Clip URL from clipboard',
			callback: async () => {
				let url: string;
				try {
					url = (await navigator.clipboard.readText()).trim();
				} catch {
					new Notice('Could not read clipboard.');
					return;
				}
				if (!url || !/^https?:\/\//.test(url)) {
					new Notice('Clipboard does not contain a valid URL.');
					return;
				}
				const { addMessage, replaceMessage } = noticeCallbacks();
				addMessage('assistant', `Clipping ${url}…`);
				const config: CommandConfig = {
					ollamaUrl: this.settings.ollamaUrl,
					serverUrl: this.settings.serverUrl,
				};
				await executeClip(url, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings.clipsFolder);
			},
		});

		// ── Find notes ─────────────────────────────────────────────────
		this.addCommand({
			id: 'ai-find-notes',
			name: 'Find notes with AI',
			callback: async () => {
				const query = await promptModal(this.app, 'Find notes with AI', 'Describe what you\'re looking for…');
				if (!query) return;
				await this.activateChatView(`/find ${query}`);
			},
		});

		// ── Read active note ───────────────────────────────────────────
		this.addCommand({
			id: 'ai-read-note',
			name: 'Summarize active note with AI',
			editorCheckCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					const { addMessage, replaceMessage } = noticeCallbacks();
					const config: CommandConfig = {
						ollamaUrl: this.settings.ollamaUrl,
						serverUrl: this.settings.serverUrl,
					};
					void executeRead('', this.app, addMessage, replaceMessage, this.settings.defaultModel, config);
				}
				return true;
			},
		});

		// ── Add abstract callout to active note ───────────────────────
		this.addCommand({
			id: 'ai-abstract-note',
			name: 'Add AI abstract callout to active note',
			editorCheckCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					void (async () => {
						const content = await this.app.vault.read(file);

						// Detect frontmatter so the callout goes after it
						const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
						const insertPos = fmMatch ? fmMatch[0].length : 0;
						const body = content.slice(insertPos);

						if (body.trimStart().startsWith('> [!abstract]')) {
							new Notice('This note already has an abstract callout.');
							return;
						}

						new Notice('Generating abstract…');
						const config: CommandConfig = {
							ollamaUrl: this.settings.ollamaUrl,
							serverUrl: this.settings.serverUrl,
						};

						try {
							const summary = await mapReduceSummarize(
								content,
								this.settings.defaultModel,
								`note "${file.basename}"`,
								config.ollamaUrl
							);

							const calloutBody = summary.split('\n').map(l => `> ${l}`).join('\n');
							const callout = `> [!abstract] Summary\n${calloutBody}`;

							const before = content.slice(0, insertPos);
							const after = body.trimStart();
							await this.app.vault.modify(file, `${before}${callout}\n\n${after}`);
							new Notice('Abstract callout added.');
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Failed to generate abstract: ${msg}`);
						}
					})();
				}
				return true;
			},
		});

		// ── Edit active note with AI ───────────────────────────────────
		this.addCommand({
			id: 'ai-edit-note',
			name: 'Edit active note with AI',
			editorCheckCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) {
					void (async () => {
						const instruction = await promptModal(this.app, 'Edit note with AI', 'Describe how to edit this note…');
						if (!instruction) return;
						const { addMessage, replaceMessage } = noticeCallbacks();
						const config: CommandConfig = {
							ollamaUrl: this.settings.ollamaUrl,
							serverUrl: this.settings.serverUrl,
						};
						await executeEdit(instruction, this.app, addMessage, replaceMessage, this.settings.defaultModel, config);
					})();
				}
				return true;
			},
		});

		// ── Create person note ─────────────────────────────────────────
		this.addCommand({
			id: 'vizier-create-person',
			name: 'Create person note (Human Network)',
			callback: async () => {
				const name = await promptModal(this.app, 'Create person note', 'Person name…');
				if (!name) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeCreatePerson(name, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Create event note ──────────────────────────────────────────
		this.addCommand({
			id: 'vizier-create-event',
			name: 'Create event note (Human Network)',
			callback: async () => {
				const title = await promptModal(this.app, 'Create event note', 'Event title…');
				if (!title) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeCreateEvent(title, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Create idea note ───────────────────────────────────────────
		this.addCommand({
			id: 'vizier-create-idea',
			name: 'Create idea/concept note (Human Network)',
			callback: async () => {
				const concept = await promptModal(this.app, 'Create idea note', 'Concept name…');
				if (!concept) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeCreateIdea(concept, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Link two entities ──────────────────────────────────────────
		this.addCommand({
			id: 'vizier-link-entities',
			name: 'Link two Human Network entities',
			callback: async () => {
				const entityA = await promptModal(this.app, 'Link entities — first entity', 'Name of first entity…');
				if (!entityA) return;
				const entityB = await promptModal(this.app, 'Link entities — second entity', 'Name of second entity…');
				if (!entityB) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				await executeLink(`${entityA} | ${entityB}`, this.app, addMessage, replaceMessage);
			},
		});

		// ── Standardize folder ────────────────────────────────────────
		this.addCommand({
			id: 'vizier-standardize',
			name: 'Standardize metadata in folder',
			callback: async () => {
				const folder = await promptModal(this.app, 'Standardize metadata', 'Folder path (e.g. Clips)…');
				if (!folder) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeStandardize(folder, this.app, addMessage, replaceMessage, this.settings.defaultModel, config);
			},
		});

		// ── Socratic questions for active note ────────────────────────
		this.addCommand({
			id: 'vizier-socratic',
			name: 'Generate Socratic questions for active note',
			editorCheckCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) {
					const { addMessage, replaceMessage } = noticeCallbacks();
					const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
					void executeSocratic('', this.app, addMessage, replaceMessage, this.settings.defaultModel, config);
				}
				return true;
			},
		});

		// ── Audit uncited claims ──────────────────────────────────────
		this.addCommand({
			id: 'vizier-sources',
			name: 'Audit active note for uncited claims',
			editorCheckCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) {
					const { addMessage, replaceMessage } = noticeCallbacks();
					const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
					void executeSources('', this.app, addMessage, replaceMessage, this.settings.defaultModel, config);
				}
				return true;
			},
		});

		// ── Weekly reflection ─────────────────────────────────────────
		this.addCommand({
			id: 'vizier-weekly-reflection',
			name: 'Generate weekly reflection',
			callback: async () => {
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeReflection('weekly', this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Monthly reflection ────────────────────────────────────────
		this.addCommand({
			id: 'vizier-monthly-reflection',
			name: 'Generate monthly reflection',
			callback: async () => {
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeReflection('monthly', this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Freewrite ─────────────────────────────────────────────────
		this.addCommand({
			id: 'vizier-freewrite',
			name: 'Open new freewrite note',
			callback: async () => {
				const { addMessage, replaceMessage } = noticeCallbacks();
				await executeFreewrite('', this.app, addMessage, replaceMessage, this.settings);
			},
		});

		// ── Setup Vizier server ────────────────────────────────────────
		this.addCommand({
			id: 'ai-setup-transcript-server',
			// eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name, obsidianmd/ui/sentence-case
			name: 'Setup / start Vizier server',
			callback: () => {
				new ServerSetupModal(this.app, this.serverManager, this.settings.serverUrl, () => {
					new Notice('Vizier server is running.');
				}).open();
			},
		});

		// ── Stop Vizier server ─────────────────────────────────────────
		this.addCommand({
			id: 'ai-stop-transcript-server',
			// eslint-disable-next-line obsidianmd/commands/no-plugin-name-in-command-name, obsidianmd/ui/sentence-case
			name: 'Stop Vizier server',
			callback: () => {
				if (this.serverManager.isRunning) {
					this.serverManager.stopServer();
					new Notice('Vizier server stopped.');
				} else {
					void this.serverManager.isServerReachable(this.settings.serverUrl).then(reachable => {
						if (reachable) {
							// eslint-disable-next-line obsidianmd/ui/sentence-case
					new Notice('Vizier server is running from a previous session — restart Obsidian or kill the Python process manually.');
						} else {
							new Notice('Vizier server is not running.');
						}
					});
				}
			},
		});

		this.addSettingTab(new AIAgentSettingTab(this.app, this));
	}

	onunload() {
		this.serverManager.stopServer();
	}

	async activateChatView(initialCommand?: string) {
		const { workspace } = this.app;

		const leaves = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
		const existing = leaves[0];
		if (existing) {
			void workspace.revealLeaf(existing);
			if (initialCommand) {
				(existing.view as ChatView).injectCommand(initialCommand);
			}
			return;
		}

		if (initialCommand) {
			this.pendingChatCommand = initialCommand;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
		void workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<AIAgentSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
