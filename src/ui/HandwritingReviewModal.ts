import { App, Modal } from 'obsidian';

/**
 * Side-by-side review of a handwriting transcription before it is saved:
 * original image on the left, editable text on the right. The model's
 * [illegible] markers point at the spots worth checking. This is the only
 * stage of the pipeline that can guarantee a correct note — ten seconds of
 * eyes beats any amount of model ensemble.
 */
export class HandwritingReviewModal extends Modal {
	private imageUrl: string;
	private text: string;
	private result: string | null = null;
	private onDone: (text: string | null) => void;

	private constructor(app: App, imageFile: File, text: string, onDone: (text: string | null) => void) {
		super(app);
		this.imageUrl = URL.createObjectURL(imageFile);
		this.text = text;
		this.onDone = onDone;
	}

	/** Open the modal and resolve with the edited text, or null on cancel/dismiss. */
	static review(app: App, imageFile: File, text: string): Promise<string | null> {
		return new Promise(resolve => {
			new HandwritingReviewModal(app, imageFile, text, resolve).open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('vizier-hw-review-modal');
		contentEl.createEl('h2', { text: 'Review transcription' });
		contentEl.createEl('p', {
			text: 'Check the text against the image before saving — [illegible] marks words the model could not read.',
			cls: 'setting-item-description',
		});

		const body = contentEl.createDiv({ cls: 'vizier-hw-review-body' });
		const img = body.createEl('img', { cls: 'vizier-hw-review-image' });
		img.src = this.imageUrl;
		const ta = body.createEl('textarea', { cls: 'vizier-hw-review-text' });
		ta.value = this.text;

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const saveBtn = btnRow.createEl('button', { text: 'Save note', cls: 'mod-cta' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

		saveBtn.onclick = () => {
			this.result = ta.value;
			this.close();
		};
		cancelBtn.onclick = () => this.close();
	}

	onClose(): void {
		URL.revokeObjectURL(this.imageUrl);
		this.contentEl.empty();
		this.onDone(this.result); // null unless Save was clicked
	}
}
