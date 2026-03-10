import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ChatApp } from './ChatApp';
import { AppContext } from '../context';
import { AIAgentSettings } from '../settings';
import type VizierPlugin from '../main';

export const VIEW_TYPE_AI_CHAT = 'vizier-chat-view';

export class ChatView extends ItemView {
	private root: Root | null = null;
	private inputInjector: ((text: string) => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private pluginSettings: AIAgentSettings,
		private plugin: VizierPlugin
	) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_AI_CHAT; }
	getDisplayText(): string { return 'Vizier'; }
	getIcon(): string { return 'chess-bishop'; }

	/** Called by the plugin to pre-fill and focus the chat input. */
	injectCommand(text: string): void {
		if (this.inputInjector) {
			this.inputInjector(text);
		}
	}

	async onOpen(): Promise<void> {
		const initialCommand = this.plugin.pendingChatCommand ?? undefined;
		this.plugin.pendingChatCommand = null;

		this.root = createRoot(this.contentEl);
		this.root.render(
			<StrictMode>
				<AppContext.Provider value={this.app}>
					<ChatApp
						settings={this.pluginSettings}
						initialCommand={initialCommand}
						onRegisterInputInjector={(fn) => { this.inputInjector = fn; }}
					/>
				</AppContext.Provider>
			</StrictMode>
		);
	}

	async onClose(): Promise<void> {
		this.inputInjector = null;
		this.root?.unmount();
	}
}
