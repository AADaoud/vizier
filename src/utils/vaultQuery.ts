import { App, TFile } from 'obsidian';

type EntityType = 'person' | 'event' | 'idea';

function matchesFolder(filePath: string, folderSet: Set<string>): boolean {
	const folder = filePath.substring(0, filePath.lastIndexOf('/'));
	for (const f of folderSet) {
		if (folder === f || folder.startsWith(f + '/')) return true;
	}
	return false;
}
export type NoteType = 'clip' | 'write' | 'handwriting' | EntityType;

export function getNotesByType(app: App, type: NoteType): TFile[] {
	return app.vault.getMarkdownFiles().filter(f => {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		return fm?.['type'] === type;
	});
}

export function getEntityNotes(app: App, folders: string[]): TFile[] {
	const folderSet = new Set(folders.filter(Boolean).map(f => f.replace(/\/$/, '')));
	return app.vault.getMarkdownFiles().filter(f => {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && ['person', 'event', 'idea'].includes(fm['type'] as string)) return true;
		if (folderSet.size === 0) return false;
		return matchesFolder(f.path, folderSet);
	});
}

export function findEntityByName(app: App, name: string, folders?: string[]): TFile | null {
	const lower = name.toLowerCase();
	const folderSet = folders ? new Set(folders.filter(Boolean).map(f => f.replace(/\/$/, ''))) : null;
	for (const file of app.vault.getMarkdownFiles()) {
		if (folderSet && folderSet.size > 0) {
			if (!matchesFolder(file.path, folderSet)) continue;
		}
		if (file.basename.toLowerCase() === lower) return file;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const title = ((fm['name'] ?? fm['title'] ?? '') as string).toLowerCase();
		if (title === lower) return file;
		const aliases = fm['aliases'];
		if (Array.isArray(aliases) && aliases.some((a: unknown) => typeof a === 'string' && a.toLowerCase() === lower)) return file;
	}
	return null;
}

/**
 * Builds an adjacency list over the entity folders using Obsidian's resolved
 * link cache — no file reads required.
 */
export function getLinkGraph(app: App, folders: string[]): Map<string, string[]> {
	const folderSet = new Set(folders.filter(Boolean).map(f => f.replace(/\/$/, '')));
	const entityPaths = new Set(
		app.vault.getMarkdownFiles()
			.filter(f => {
				if (folderSet.size === 0) return false;
				return matchesFolder(f.path, folderSet);
			})
			.map(f => f.path)
	);
	const graph = new Map<string, string[]>();
	for (const filePath of entityPaths) {
		const resolved = (app.metadataCache.resolvedLinks as Record<string, Record<string, number>>)[filePath] ?? {};
		graph.set(filePath, Object.keys(resolved).filter(p => entityPaths.has(p)));
	}
	return graph;
}

export function getNotesModifiedSince(app: App, since: Date): TFile[] {
	const ts = since.getTime();
	return app.vault.getMarkdownFiles().filter(f => f.stat.mtime >= ts);
}

export function getNotesByFrontmatterTag(app: App, tag: string): TFile[] {
	const lower = tag.replace(/^#/, '').toLowerCase();
	return app.vault.getMarkdownFiles().filter(f => {
		const fmTags = app.metadataCache.getFileCache(f)?.frontmatter?.['tags'];
		if (Array.isArray(fmTags)) return fmTags.some((t: unknown) => typeof t === 'string' && t.toLowerCase() === lower);
		if (typeof fmTags === 'string') return fmTags.toLowerCase() === lower;
		return false;
	});
}
