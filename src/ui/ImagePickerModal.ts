import { App, Modal } from 'obsidian';

export class ImagePickerModal extends Modal {
	private imageUrls: string[];
	private resolve: (url: string | null) => void;
	private resolved = false;

	constructor(app: App, imageUrls: string[], resolve: (url: string | null) => void) {
		super(app);
		this.imageUrls = imageUrls;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Choose an image' });

		const grid = contentEl.createDiv({ cls: 'vizier-image-picker-grid' });

		for (const url of this.imageUrls) {
			const cell = grid.createDiv({ cls: 'vizier-image-picker-cell' });
			const img = cell.createEl('img', { cls: 'vizier-image-picker-img' });
			img.src = url;
			img.loading = 'lazy';

			cell.addEventListener('click', () => {
				this.resolved = true;
				this.resolve(url);
				this.close();
			});
		}

		const skipBtn = contentEl.createEl('button', {
			text: 'Skip — no image',
			cls: 'vizier-wiki-custom-btn',
		});
		skipBtn.style.marginTop = '10px';
		skipBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) this.resolve(null);
		this.contentEl.empty();
	}
}

export function showImagePickerModal(app: App, imageUrls: string[]): Promise<string | null> {
	if (imageUrls.length === 0) return Promise.resolve(null);
	return new Promise((resolve) => new ImagePickerModal(app, imageUrls, resolve).open());
}
