import { Plugin, WorkspaceLeaf } from 'obsidian';
import { AIAgentSettings, DEFAULT_SETTINGS, AIAgentSettingTab } from './settings';
import { ChatView, VIEW_TYPE_AI_CHAT } from './ui/ChatView';

export default class MyPlugin extends Plugin {
	settings: AIAgentSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_AI_CHAT,
			(leaf) => new ChatView(leaf, this.settings)
		);

		this.addRibbonIcon('bot', 'Open AI Agent', () => {
			void this.activateChatView();
		});

		this.addCommand({
			id: 'open-ai-agent-chat',
			name: 'Open AI Agent chat',
			callback: () => {
				void this.activateChatView();
			},
		});

		this.addSettingTab(new AIAgentSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
	}

	async activateChatView() {
		const { workspace } = this.app;

		const leaves = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
		if (leaves.length > 0) {
			workspace.revealLeaf(leaves[0] as WorkspaceLeaf);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<AIAgentSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
