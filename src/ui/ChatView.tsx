import { StrictMode } from 'react';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root, createRoot } from 'react-dom/client';
import { ChatApp } from './ChatApp';
import { AppContext } from '../context';
import { AIAgentSettings } from '../settings';

export const VIEW_TYPE_AI_CHAT = 'ai-agent-chat-view';

export class ChatView extends ItemView {
	private root: Root | null = null;

	constructor(leaf: WorkspaceLeaf, private pluginSettings: AIAgentSettings) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_AI_CHAT;
	}

	getDisplayText(): string {
		return 'AI Agent';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		this.root = createRoot(this.contentEl);
		this.root.render(
			<StrictMode>
				<AppContext.Provider value={this.app}>
					<ChatApp settings={this.pluginSettings} />
				</AppContext.Provider>
			</StrictMode>
		);
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
	}
}
