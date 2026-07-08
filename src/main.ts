import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { AIAgentSettings, DEFAULT_SETTINGS, AIAgentSettingTab, migrateLegacyRoleDefaults } from './settings';
import { ChatView, VIEW_TYPE_AI_CHAT } from './ui/ChatView';
import { TranscriptServerManager, ServerSetupModal } from './ui/ServerSetupModal';
import { executeWrite, executeEdit, executeClip, executeRead, CommandConfig, AddMessage } from './commands/slashCommands';
import { executeCreatePerson, executeCreateEvent, executeCreateIdea, executeCreateEntity, executeLink } from './commands/humanNetworkCommands';
import { executeStandardize } from './commands/miscCommands';
import { executeSocratic, executeReflection, executeFreewrite, executeSources } from './commands/reflectionCommands';
import { promptModal } from './ui/PromptModal';
import { mapReduceSummarize } from './utils/chunking';
import { initTraces } from './traces';
import { initDebugLog, setDebugLogging } from './debug_log';
import { warmCapabilities, buildLLMConfig } from './llm_core';
import { invalidateVaultCache } from './agent/prompt_builder';
import { setAgentVaultIndex, setAgentPluginDir, setAgentMemoryManager } from './agent/tool_execution';
import { MemoryManager } from './memory/memory_manager';
import { VaultIndex } from './memory/vault_index';
import { runContradictionScan } from './epistemic/contradiction_engine';
import { schedulerTick, TICK_MS, STARTUP_DELAY } from './scheduler';
import { beginActivity, updateActivity, endActivity } from './ui/activity';
import { registerServerEnsurer } from './server_lifecycle';

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
	memoryManager: MemoryManager | null = null;
	vaultIndex: VaultIndex | null = null;

	/** Pending command to inject into a newly opened chat view. */
	pendingChatCommand: string | null = null;

	async onload() {
		await this.loadSettings();

		// manifest.dir is vault-relative (.obsidian/plugins/vizier) — Node fs
		// (traces, memories, vault index) needs the absolute filesystem path.
		const adapter = this.app.vault.adapter;
		const relDir = this.manifest.dir ?? '';
		const pluginDir = adapter instanceof FileSystemAdapter && relDir
			? adapter.getFullPath(relDir)
			: '';

		// ── Phase 0: initialise observability ─────────────────────────
		initTraces(pluginDir);
		initDebugLog(pluginDir);
		setDebugLogging(this.settings.features.debugLog ?? false);

		// ── Phase 0: warm capability cache for all configured models ──
		void warmCapabilities(buildLLMConfig(this.settings));

		// ── Phase 3: give agent tools access to shared context ────────
		setAgentPluginDir(pluginDir);

		// ── Phase 2: initialise memory and vault index ─────────────────
		if (this.settings.features.memory && pluginDir) {
			this.memoryManager = new MemoryManager(pluginDir);
			this.vaultIndex    = new VaultIndex(pluginDir);
			setAgentVaultIndex(this.vaultIndex);
			setAgentMemoryManager(this.memoryManager);

			// Incremental vault re-index in the background — deferred well after
			// launch so it doesn't compete with Obsidian startup, Ollama warm-up,
			// and capability probing (that contention both slowed launch and made
			// the first embeddings fail). Steady-state runs are cheap: unchanged
			// chunks are skipped via text_hash, so no embeddings are issued.
			const REINDEX_STARTUP_DELAY = 20_000;
			this.app.workspace.onLayoutReady(() => {
				const startReindex = () => {
					beginActivity('reindex', 'Updating vault index');
					void this.vaultIndex?.reindexVault(this.app, this.settings, (done, total) => {
						if (done % 20 === 0 || done === total) updateActivity('reindex', `${done}/${total} notes`);
					})
						.then(r => {
							if (r.aborted) {
								endActivity('reindex', false, `Vault index stopped — embeddings failing (${r.embedFailures} chunks)`);
								// The activity ticker only shows inside the chat view —
								// surface aborts as a Notice so they are never invisible.
								new Notice(`Vizier: vault indexing stopped early — embedding requests kept failing (${r.embedFailures} chunks). Check Ollama and the embedding model, then run "Rebuild vault search index".`, 10_000);
							}
							else if (r.chunksAdded > 0 || r.embedFailures > 0) {
								const failNote = r.embedFailures > 0 ? ` (${r.embedFailures} chunks failed)` : '';
								endActivity('reindex', r.embedFailures === 0, `Vault index updated (${r.chunksAdded} new chunks)${failNote}`);
							}
							else endActivity('reindex', true, undefined, true); // nothing changed — vanish quietly
						})
						.catch((err: unknown) => {
							endActivity('reindex', false, 'Vault index failed — check embedding model');
							new Notice(`Vizier: vault indexing failed — ${err instanceof Error ? err.message : String(err)}`, 10_000);
							console.warn('[Vizier] background vault reindex failed:', err);
						});
				};
				this.registerInterval(window.setTimeout(startReindex, REINDEX_STARTUP_DELAY) as unknown as number);
			});

			// Keep vault index up to date on file changes
			this.registerEvent(
				this.app.vault.on('modify', (file) => {
					if (file instanceof TFile && file.extension === 'md') {
						invalidateVaultCache();
						void this.vaultIndex?.indexFile(file, this.app, this.settings);
					}
				})
			);
			this.registerEvent(
				this.app.vault.on('create', (file) => {
					if (file instanceof TFile && file.extension === 'md') {
						invalidateVaultCache();
						void this.vaultIndex?.indexFile(file, this.app, this.settings);
					}
				})
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) => {
					if (file instanceof TFile) {
						invalidateVaultCache();
						void this.vaultIndex?.removeFile(file.path);
					}
				})
			);
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					if (file instanceof TFile && file.extension === 'md') {
						invalidateVaultCache();
						void this.vaultIndex?.removeFile(oldPath);
						void this.vaultIndex?.indexFile(file, this.app, this.settings);
					}
				})
			);
		}

		this.serverManager = new TranscriptServerManager(this.app, relDir);

		// Let commands and agent tools auto-start the server on demand
		// (transcripts, Wikipedia lookups, OCR) instead of failing with
		// "server not running" and asking the user to start it by hand.
		registerServerEnsurer((url) => this.serverManager.ensureServer(url));

		// Auto-start with Obsidian when setup was already done. Deferred so it
		// never competes with vault load; failure is quiet — on-demand ensure
		// (or the setup modal) covers it later.
		if (this.settings.features.autoStartServer ?? true) {
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => {
					if (!this.serverManager.isSetupDone) return;
					void this.serverManager.ensureServer(this.settings.serverUrl).then(r => {
						if (r === 'started') console.debug('[Vizier] server auto-started.');
						else if (r === 'offline') console.warn('[Vizier] server auto-start failed — start it via "Setup / start Vizier server".');
					});
				}, 3000);
			});
		}

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

		// ── Phase 0: run stats ─────────────────────────────────────────
		this.addCommand({
			id: 'run-stats',
			name: 'Show run stats',
			callback: () => { void this.activateChatView('/runstats'); },
		});

		// ── Phase 2: rebuild vault index ───────────────────────────────
		this.addCommand({
			id: 'reindex-vault',
			name: 'Rebuild vault search index',
			callback: () => {
				if (!this.vaultIndex) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case
				new Notice('Vault index is disabled. Enable memory in Vizier settings.');
					return;
				}
				new Notice('Rebuilding vault index… this may take a moment.');
				beginActivity('reindex', 'Rebuilding vault index');
				void this.vaultIndex.reindexVault(this.app, this.settings, (done, total) => {
					if (done % 10 === 0 || done === total) updateActivity('reindex', `${done}/${total} notes`);
				})
					.then((r) => {
						endActivity('reindex', !r.aborted, r.aborted ? 'Vault index stopped — embeddings failing' : `Vault index rebuilt (${r.chunksAdded} chunks added)`);
						const stats = this.vaultIndex?.getStats();
						const failNote = r.embedFailures > 0 ? ` (${r.embedFailures} chunks failed to embed)` : '';
						const abortNote = r.aborted ? ' — stopped early: embeddings failing, check Ollama and the embedding model' : '';
						new Notice(`Vault index rebuilt: ${stats?.total_chunks ?? 0} chunks from ${stats?.total_files ?? 0} notes.${failNote}${abortNote}`, 8000);
					})
					.catch((err: unknown) => {
						endActivity('reindex', false, 'Vault index failed');
						new Notice(`Vault index failed: ${err instanceof Error ? err.message : String(err)}`, 10_000);
					});
			},
		});

		// ── Phase 3: contradiction scan ────────────────────────────────
		this.addCommand({
			id: 'contradiction-scan',
			name: 'Scan vault claims for contradictions',
			callback: () => {
				if (!pluginDir) { new Notice('Plugin directory unavailable.'); return; }
				new Notice('Scanning claims for contradictions…');
				void runContradictionScan(this.app, this.settings, pluginDir)
					.then(r => {
						new Notice(`Contradiction scan: ${r.claims} claims, ${r.checked} pairs checked, ${r.flagged} flagged.`, 8000);
					})
					.catch((err: unknown) => {
						new Notice(`Contradiction scan failed: ${err instanceof Error ? err.message : String(err)}`, 10_000);
					});
			},
		});

		// ── Phase 4: intake + briefing ─────────────────────────────────
		this.addCommand({
			id: 'run-intake',
			name: 'Run feed intake now',
			callback: () => { void this.activateChatView('/intake'); },
		});
		this.addCommand({
			id: 'generate-briefing',
			name: 'Generate daily briefing',
			callback: () => { void this.activateChatView('/briefing'); },
		});

		// ── Phase 6: proactive scheduler ───────────────────────────────
		// Daily cadence (intake → briefing → contradiction scan) while
		// Obsidian is open. First tick is delayed so reindex/warmup finish.
		if (pluginDir) {
			const tick = () => {
				void schedulerTick(this.app, this.settings, pluginDir, this.memoryManager)
					.catch((err: unknown) => console.warn('[Vizier] scheduler tick failed:', err));
			};
			this.registerInterval(window.setTimeout(tick, STARTUP_DELAY) as unknown as number);
			this.registerInterval(window.setInterval(tick, TICK_MS));

			this.addCommand({
				id: 'run-daily-jobs',
				name: 'Run daily jobs now (intake, briefing, contradiction scan)',
				callback: () => {
					new Notice('Running daily jobs…');
					void schedulerTick(this.app, this.settings, pluginDir, this.memoryManager, true)
						.then(ran => new Notice(ran.length ? `Daily jobs done: ${ran.join(', ')}` : 'No jobs enabled — check feature toggles in settings.', 8000))
						.catch((err: unknown) => new Notice(`Daily jobs failed: ${err instanceof Error ? err.message : String(err)}`, 8000));
				},
			});
		}

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
								content, this.settings.defaultModel, `note "${file.basename}"`, config.ollamaUrl
							);
							const calloutBody = summary.split('\n').map(l => `> ${l}`).join('\n');
							const callout = `> [!abstract] Summary\n${calloutBody}`;
							const before = content.slice(0, insertPos);
							const after  = body.trimStart();
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
			id: 'create-person',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
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
			id: 'create-event',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
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
			id: 'create-idea',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: 'Create idea/concept note (Human Network)',
			callback: async () => {
				const concept = await promptModal(this.app, 'Create idea note', 'Concept name…');
				if (!concept) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeCreateIdea(concept, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Create generic entity note ────────────────────────────────
		this.addCommand({
			id: 'create-entity',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: 'Create entity note (Human Network)',
			callback: async () => {
				const entityType = await promptModal(this.app, 'Create entity note', 'Entity type (e.g. organization, place, movement)…');
				if (!entityType) return;
				const name = await promptModal(this.app, 'Create entity note', `${entityType} name…`);
				if (!name) return;
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeCreateEntity(`${entityType} | ${name}`, this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Link two entities ──────────────────────────────────────────
		this.addCommand({
			id: 'link-entities',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
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
			id: 'standardize',
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
			id: 'socratic',
			// eslint-disable-next-line obsidianmd/ui/sentence-case
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
			id: 'sources',
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
			id: 'weekly-reflection',
			name: 'Generate weekly reflection',
			callback: async () => {
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeReflection('weekly', this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Monthly reflection ────────────────────────────────────────
		this.addCommand({
			id: 'monthly-reflection',
			name: 'Generate monthly reflection',
			callback: async () => {
				const { addMessage, replaceMessage } = noticeCallbacks();
				const config: CommandConfig = { ollamaUrl: this.settings.ollamaUrl, serverUrl: this.settings.serverUrl };
				await executeReflection('monthly', this.app, addMessage, replaceMessage, this.settings.defaultModel, config, this.settings);
			},
		});

		// ── Freewrite ─────────────────────────────────────────────────
		this.addCommand({
			id: 'freewrite',
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

		const leaves   = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
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
		const loaded = await this.loadData() as Partial<AIAgentSettings> | null;
		// Deep merge roles (new field — may be absent in old saved data)
		const base = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		if (!base.roles) base.roles = DEFAULT_SETTINGS.roles;
		// Merge feature flags so newly added flags get their defaults
		base.features = { ...DEFAULT_SETTINGS.features, ...(loaded?.features ?? {}) };
		// Per-role: merge so existing models are preserved
		for (const role of ['default', 'utility', 'research', 'embedding'] as const) {
			if (!base.roles[role]?.models?.length) {
				base.roles[role] = DEFAULT_SETTINGS.roles[role];
			}
		}
		const migrated = migrateLegacyRoleDefaults(base.roles);
		this.settings = base;
		if (migrated) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
