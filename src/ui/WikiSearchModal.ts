import { App, Modal } from 'obsidian';
import { WikiSearchResult } from '../types/humanNetwork';

type WikiSearchSelection = WikiSearchResult | { custom: true } | null;

export class WikiSearchModal extends Modal {
	private results: WikiSearchResult[];
	private resolve: (value: WikiSearchSelection) => void;
	private resolved = false;

	constructor(app: App, results: WikiSearchResult[], resolve: (value: WikiSearchSelection) => void) {
		super(app);
		this.results = results;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		contentEl.createEl('h3', { text: 'Select a Wikipedia page' });

		const list = contentEl.createDiv({ cls: 'vizier-wiki-search-list' });

		this.results.forEach((result, i) => {
			const row = list.createDiv({ cls: 'vizier-wiki-result' });

			const titleEl = row.createEl('div', { cls: 'vizier-wiki-result-title' });
			titleEl.createEl('span', { text: `${i + 1}. `, cls: 'vizier-wiki-result-num' });
			titleEl.createEl('strong', { text: result.title });

			if (result.snippet) {
				row.createEl('div', { text: result.snippet, cls: 'vizier-wiki-result-snippet' });
			}

			row.addEventListener('click', () => {
				this.resolved = true;
				this.resolve(result);
				this.close();
			});
		});

		const divider = contentEl.createEl('hr', { cls: 'vizier-wiki-divider' });
		divider.setCssStyles({ margin: '8px 0' });

		const customBtn = contentEl.createEl('button', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: 'Custom entry (not on Wikipedia)',
			cls: 'vizier-wiki-custom-btn',
		});
		customBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({ custom: true });
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) this.resolve(null);
		this.contentEl.empty();
	}
}

export function showWikiSearchModal(
	app: App,
	results: WikiSearchResult[]
): Promise<WikiSearchSelection> {
	return new Promise((resolve) => new WikiSearchModal(app, results, resolve).open());
}
