import { App, Modal, Notice, Plugin } from 'obsidian';
import { AIAgentSettings, DEFAULT_SETTINGS, AIAgentSettingTab } from './settings';
import { ChatView, VIEW_TYPE_AI_CHAT } from './ui/ChatView';
import { TranscriptServerManager, ServerSetupModal } from './ui/ServerSetupModal';
import { executeWrite, executeClip, executeRead, CommandConfig, AddMessage } from './commands/slashCommands';
import { mapReduceSummarize } from './utils/chunking';

// ── Simple text-input modal ────────────────────────────────────────────────

class PromptModal extends Modal {
	private title: string;
	private placeholder: string;
	private resolve: (value: string | null) => void;

	constructor(app: App, title: string, placeholder: string, resolve: (value: string | null) => void) {
		super(app);
		this.title = title;
		this.placeholder = placeholder;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });

		const input = contentEl.createEl('input', { type: 'text', cls: 'ai-prompt-modal-input' });
		input.placeholder = this.placeholder;

		const submit = () => {
			const val = input.value.trim();
			this.resolve(val || null);
			this.close();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
			if (e.key === 'Escape') { this.resolve(null); this.close(); }
		});

		const btnRow = contentEl.createDiv({ cls: 'ai-prompt-modal-buttons' });
		const ok = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
		ok.onclick = submit;
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => { this.resolve(null); this.close(); };

		setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function promptModal(app: App, title: string, placeholder: string): Promise<string | null> {
	return new Promise((resolve) => new PromptModal(app, title, placeholder, resolve).open());
}

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
				addMessage('assistant', 'Generating note…');
				const config: CommandConfig = {
					ollamaUrl: this.settings.ollamaUrl,
					serverUrl: this.settings.serverUrl,
				};
				await executeWrite(topic, this.app, replaceMessage, this.settings.defaultModel, config, this.settings.aiNotesFolder);
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
					const { addMessage } = noticeCallbacks();
					const config: CommandConfig = {
						ollamaUrl: this.settings.ollamaUrl,
						serverUrl: this.settings.serverUrl,
					};
					void executeRead('', this.app, addMessage, this.settings.defaultModel, config);
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

		// ── Setup Vizier server ────────────────────────────────────────
		this.addCommand({
			id: 'ai-setup-transcript-server',
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
			name: 'Stop Vizier server',
			callback: () => {
				if (this.serverManager.isRunning) {
					this.serverManager.stopServer();
					new Notice('Vizier server stopped.');
				} else {
					void this.serverManager.isServerReachable(this.settings.serverUrl).then(reachable => {
						if (reachable) {
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
