import { App } from 'obsidian';

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function sanitizeFilename(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').replace(/-{2,}/g, '-').trim();
	return cleaned || 'untitled';
}

export function sanitizeTag(tag: string): string {
	const cleaned = tag
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9\-_]/g, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
	return cleaned || '';
}

/** Tag list for write/clip/handwriting notes — used as `tags:\n${result}`. */
export function buildYamlTags(tags: string[]): string {
	return tags
		.map(t => sanitizeTag(t))
		.filter(t => t.length > 0)
		.filter((t, i, arr) => arr.indexOf(t) === i)
		.map(t => `  - ${t}`)
		.join('\n');
}

/** Quoted string array for Human Network relation fields — used as `field: ${result}`. */
export function buildYamlArray(items: string[]): string {
	if (items.length === 0) return '[]';
	return '\n' + items.map(i => `  - "${i.replace(/"/g, '\\"')}"`).join('\n');
}

/** Sanitized tag array for Human Network notes — used as `tags: ${result}`. */
export function buildYamlTagArray(tags: string[]): string {
	const clean = tags
		.map(t => sanitizeTag(t))
		.filter(t => t.length > 0)
		.filter((t, i, arr) => arr.indexOf(t) === i);
	if (clean.length === 0) return '[]';
	return '\n' + clean.map(t => `  - ${t}`).join('\n');
}

/** ISO dates (YYYY-MM-DD) are unquoted for Obsidian Bases; anything else is quoted. */
export function buildDateField(val: string): string {
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(val.trim());
	if (iso) return val.trim();
	return val.trim() ? `"${val.trim()}"` : '""';
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
		await app.vault.createFolder(folderPath);
	}
}

export async function deduplicatePath(app: App, base: string, ext = '.md'): Promise<string> {
	let path = `${base}${ext}`;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = `${base}-${n}${ext}`;
		n++;
	}
	return path;
}
