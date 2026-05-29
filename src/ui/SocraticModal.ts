import { App, Modal } from 'obsidian';

export class SocraticModal extends Modal {
	private questions: string[];
	private onConfirm: (answers: string[]) => void;
	private textareas: HTMLTextAreaElement[] = [];

	constructor(app: App, questions: string[], onConfirm: (answers: string[]) => void) {
		super(app);
		this.questions = questions;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		 
		contentEl.createEl('h2', { text: 'Socratic questions' });
		contentEl.createEl('p', { text: 'Answer each question in your own words. Your answers will be appended to the note.' });

		for (let i = 0; i < this.questions.length; i++) {
			const section = contentEl.createDiv({ cls: 'vizier-socratic-section' });
			section.createEl('p', { text: `${i + 1}. ${this.questions[i] ?? ''}`, cls: 'vizier-socratic-question' });
			const ta = section.createEl('textarea', { cls: 'vizier-socratic-answer' });
			ta.rows = 3;
			ta.placeholder = 'Your answer…';
			this.textareas.push(ta);
		}

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const confirmBtn = btnRow.createEl('button', { text: 'Save answers', cls: 'mod-cta' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

		confirmBtn.onclick = () => {
			this.onConfirm(this.textareas.map(t => t.value));
			this.close();
		};
		cancelBtn.onclick = () => this.close();

		setTimeout(() => this.textareas[0]?.focus(), 50);
	}

	onClose(): void { this.contentEl.empty(); }
}
