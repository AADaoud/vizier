import { App, Modal } from 'obsidian';
import { ManualPersonData, ManualEventData } from '../types/humanNetwork';

// ── Person ────────────────────────────────────────────────────────────────

class ManualPersonModal extends Modal {
	private resolve: (value: ManualPersonData | null) => void;
	private resolved = false;

	constructor(app: App, resolve: (value: ManualPersonData | null) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Add person manually' });

		const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};

		const addField = (label: string, key: string, placeholder: string, isTextarea = false) => {
			const wrap = contentEl.createDiv({ cls: 'vizier-modal-field' });
			wrap.createEl('label', { text: label });
			if (isTextarea) {
				const ta = wrap.createEl('textarea', { cls: 'ai-prompt-modal-input' });
				ta.placeholder = placeholder;
				ta.rows = 4;
				fields[key] = ta;
			} else {
				const inp = wrap.createEl('input', { type: 'text', cls: 'ai-prompt-modal-input' });
				inp.placeholder = placeholder;
				fields[key] = inp;
			}
		};

		addField('Name *', 'name', 'Full name');
		addField('Born', 'born', 'YYYY-MM-DD');
		addField('Died', 'died', 'YYYY-MM-DD (leave blank if alive)');
		addField('Nationality', 'nationality', 'e.g. American, French (comma-separated)');
		addField('Roles', 'roles', 'e.g. Politician, General (comma-separated)');
		addField('Bio', 'bio', 'Brief biography…', true);

		const btnRow = contentEl.createDiv({ cls: 'ai-prompt-modal-buttons' });
		const ok = btnRow.createEl('button', { text: 'Create note', cls: 'mod-cta' });
		ok.onclick = () => this.submit(fields);
		btnRow.createEl('button', { text: 'Cancel' }).onclick = () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		};

		setTimeout(() => (fields['name'] as HTMLInputElement)?.focus(), 50);
	}

	private submit(fields: Record<string, HTMLInputElement | HTMLTextAreaElement>) {
		const name = (fields['name']?.value ?? '').trim();
		if (!name) {
			fields['name']?.addClass('vizier-field-error');
			return;
		}
		this.resolved = true;
		this.resolve({
			name,
			born: (fields['born']?.value ?? '').trim(),
			died: (fields['died']?.value ?? '').trim(),
			nationality: (fields['nationality']?.value ?? '').trim(),
			roles: (fields['roles']?.value ?? '').trim(),
			bio: (fields['bio']?.value ?? '').trim(),
		});
		this.close();
	}

	onClose(): void {
		if (!this.resolved) this.resolve(null);
		this.contentEl.empty();
	}
}

// ── Event ─────────────────────────────────────────────────────────────────

class ManualEventModal extends Modal {
	private resolve: (value: ManualEventData | null) => void;
	private resolved = false;

	constructor(app: App, resolve: (value: ManualEventData | null) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Add event manually' });

		const fields: Record<string, HTMLInputElement | HTMLSelectElement> = {};

		const addField = (label: string, key: string, placeholder: string) => {
			const wrap = contentEl.createDiv({ cls: 'vizier-modal-field' });
			wrap.createEl('label', { text: label });
			const inp = wrap.createEl('input', { type: 'text', cls: 'ai-prompt-modal-input' });
			inp.placeholder = placeholder;
			fields[key] = inp;
		};

		addField('Title *', 'title', 'Event name');
		addField('Date', 'date', 'YYYY-MM-DD');
		addField('End date', 'date_end', 'YYYY-MM-DD (leave blank if single day)');
		addField('Location', 'location', 'City, Country');
		addField('Participants', 'participants', 'e.g. John F. Kennedy, Soviet Union (comma-separated)');
		addField('Timeline tags', 'timeline_tags', 'e.g. Cold War, Middle East (comma-separated)');

		const sigWrap = contentEl.createDiv({ cls: 'vizier-modal-field' });
		sigWrap.createEl('label', { text: 'Significance' });
		const sel = sigWrap.createEl('select', { cls: 'ai-prompt-modal-input' });
		['high', 'medium', 'low'].forEach(v => {
			const opt = sel.createEl('option', { text: v, value: v });
			if (v === 'medium') opt.selected = true;
		});
		fields['significance'] = sel;

		const btnRow = contentEl.createDiv({ cls: 'ai-prompt-modal-buttons' });
		const ok = btnRow.createEl('button', { text: 'Create note', cls: 'mod-cta' });
		ok.onclick = () => this.submit(fields);
		btnRow.createEl('button', { text: 'Cancel' }).onclick = () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		};

		setTimeout(() => (fields['title'] as HTMLInputElement)?.focus(), 50);
	}

	private submit(fields: Record<string, HTMLInputElement | HTMLSelectElement>) {
		const title = (fields['title']?.value ?? '').trim();
		if (!title) {
			fields['title']?.addClass('vizier-field-error');
			return;
		}
		this.resolved = true;
		this.resolve({
			title,
			date: (fields['date']?.value ?? '').trim(),
			date_end: (fields['date_end']?.value ?? '').trim(),
			location: (fields['location']?.value ?? '').trim(),
			participants: (fields['participants']?.value ?? '').trim(),
			timeline_tags: (fields['timeline_tags']?.value ?? '').trim(),
			significance: (fields['significance']?.value ?? 'medium').trim(),
		});
		this.close();
	}

	onClose(): void {
		if (!this.resolved) this.resolve(null);
		this.contentEl.empty();
	}
}

// ── Public helpers ────────────────────────────────────────────────────────

export function promptManualPerson(app: App): Promise<ManualPersonData | null> {
	return new Promise((resolve) => new ManualPersonModal(app, resolve).open());
}

export function promptManualEvent(app: App): Promise<ManualEventData | null> {
	return new Promise((resolve) => new ManualEventModal(app, resolve).open());
}
