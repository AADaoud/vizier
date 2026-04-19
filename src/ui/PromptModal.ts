import { App, Modal } from 'obsidian';

export class PromptModal extends Modal {
	private title: string;
	private placeholder: string;
	private resolve: (value: string | null) => void;
	private resolved = false;

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
			this.resolved = true;
			this.resolve(val || null);
			this.close();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
			if (e.key === 'Escape') { this.resolved = true; this.resolve(null); this.close(); }
		});

		const btnRow = contentEl.createDiv({ cls: 'ai-prompt-modal-buttons' });
		const ok = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
		ok.onclick = submit;
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => { this.resolved = true; this.resolve(null); this.close(); };

		setTimeout(() => input.focus(), 50);
	}

	onClose(): void {
		if (!this.resolved) this.resolve(null);
		this.contentEl.empty();
	}
}

export function promptModal(app: App, title: string, placeholder: string): Promise<string | null> {
	return new Promise((resolve) => new PromptModal(app, title, placeholder, resolve).open());
}
