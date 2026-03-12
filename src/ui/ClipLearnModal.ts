import { App, Modal } from 'obsidian';

interface StudyGuideSections {
	overview: string;
	keyConcepts: Array<{ term: string; definition: string }>;
	takeaways: string[];
	reviewQA: Array<{ question: string; answer: string }>;
}

export class ClipLearnModal extends Modal {
	private title: string;
	private studyGuideContent: string;

	constructor(app: App, title: string, studyGuideContent: string) {
		super(app);
		this.title = title;
		this.studyGuideContent = studyGuideContent;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('vizier-learn-modal');

		contentEl.createEl('h2', { text: this.title, cls: 'vizier-learn-title' });

		const sections = this.parseSections(this.studyGuideContent);

		// Overview
		if (sections.overview) {
			const overviewEl = contentEl.createDiv({ cls: 'vizier-learn-section' });
			overviewEl.createEl('h3', { text: 'Overview', cls: 'vizier-learn-section-heading' });
			overviewEl.createEl('p', { text: sections.overview, cls: 'vizier-learn-overview-text' });
		}

		// Key Concepts
		if (sections.keyConcepts.length > 0) {
			const conceptsEl = contentEl.createDiv({ cls: 'vizier-learn-section' });
			conceptsEl.createEl('h3', { text: 'Key concepts', cls: 'vizier-learn-section-heading' });
			const listEl = conceptsEl.createEl('dl', { cls: 'vizier-learn-concepts-list' });
			for (const { term, definition } of sections.keyConcepts) {
				listEl.createEl('dt', { text: term, cls: 'vizier-learn-concept-term' });
				listEl.createEl('dd', { text: definition, cls: 'vizier-learn-concept-def' });
			}
		}

		// Main Takeaways
		if (sections.takeaways.length > 0) {
			const takeawaysEl = contentEl.createDiv({ cls: 'vizier-learn-section' });
			takeawaysEl.createEl('h3', { text: 'Main takeaways', cls: 'vizier-learn-section-heading' });
			const ulEl = takeawaysEl.createEl('ul', { cls: 'vizier-learn-takeaways-list' });
			for (const item of sections.takeaways) {
				ulEl.createEl('li', { text: item, cls: 'vizier-learn-takeaway-item' });
			}
		}

		// Review Questions — interactive reveal
		if (sections.reviewQA.length > 0) {
			const qaEl = contentEl.createDiv({ cls: 'vizier-learn-section' });
			qaEl.createEl('h3', { text: 'Review questions', cls: 'vizier-learn-section-heading' });
			qaEl.createEl('p', {
				text: 'Click a question to reveal the answer.',
				cls: 'vizier-learn-qa-hint',
			});

			for (const { question, answer } of sections.reviewQA) {
				const itemEl = qaEl.createDiv({ cls: 'vizier-learn-qa-item' });

				const questionBtn = itemEl.createEl('button', { cls: 'vizier-learn-qa-question' });
				questionBtn.createSpan({ cls: 'vizier-learn-qa-chevron', text: '▶' });
				questionBtn.createSpan({ cls: 'vizier-learn-qa-question-text', text: question });

				itemEl.createDiv({ text: answer, cls: 'vizier-learn-qa-answer' });

				questionBtn.addEventListener('click', () => {
					itemEl.toggleClass('is-open', !itemEl.hasClass('is-open'));
				});
			}
		}

		// Close button
		const btnRow = contentEl.createDiv({ cls: 'vizier-learn-btn-row' });
		const closeBtn = btnRow.createEl('button', { text: 'Close', cls: 'mod-cta' });
		closeBtn.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private parseSections(content: string): StudyGuideSections {
		const result: StudyGuideSections = {
			overview: '',
			keyConcepts: [],
			takeaways: [],
			reviewQA: [],
		};

		const parts = content.split(/^##\s+/m).filter(p => p.trim());

		for (const part of parts) {
			const newline = part.indexOf('\n');
			if (newline === -1) continue;
			const heading = part.slice(0, newline).trim().toLowerCase();
			const body = part.slice(newline + 1).trim();

			if (heading.includes('overview')) {
				result.overview = body.replace(/\n+/g, ' ').trim();

			} else if (heading.includes('key concept')) {
				for (const line of body.split('\n')) {
					const match = line.match(/^\*\*(.+?)\*\*[:\s]+(.+)$/);
					if (match && match[1] && match[2]) {
						result.keyConcepts.push({ term: match[1].trim(), definition: match[2].trim() });
					}
				}

			} else if (heading.includes('takeaway')) {
				for (const line of body.split('\n')) {
					const stripped = line.replace(/^[-*]\s+/, '').trim();
					if (stripped) result.takeaways.push(stripped);
				}

			} else if (heading.includes('review') || heading.includes('question')) {
				for (const line of body.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					const sepIdx = trimmed.indexOf(' // ');
					if (sepIdx === -1) continue;
					const qPart = trimmed.slice(0, sepIdx).replace(/^Q:\s*/i, '').trim();
					const aPart = trimmed.slice(sepIdx + 4).replace(/^A:\s*/i, '').trim();
					if (qPart && aPart) {
						result.reviewQA.push({ question: qPart, answer: aPart });
					}
				}
			}
		}

		return result;
	}
}
