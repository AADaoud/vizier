/**
 * Builds a fake Obsidian `App` backed by in-memory note descriptors, exposing
 * just the slice of the vault / metadataCache API that vaultQuery.ts and the
 * command layer read. Lets us assert query behaviour without a real vault.
 */

import { TFile } from './obsidian';

export interface FakeNote {
	path: string;
	frontmatter?: Record<string, unknown>;
	mtime?: number;
	/** Resolved outgoing links (target path -> count), as Obsidian exposes them. */
	links?: string[];
}

export interface FakeApp {
	vault: {
		getMarkdownFiles: () => TFile[];
		getAbstractFileByPath: (p: string) => TFile | null;
		createFolder: (p: string) => Promise<void>;
	};
	metadataCache: {
		getFileCache: (f: TFile) => { frontmatter?: Record<string, unknown> } | null;
		resolvedLinks: Record<string, Record<string, number>>;
	};
	__createdFolders: string[];
}

function makeFile(note: FakeNote): TFile {
	const f = new TFile();
	f.path = note.path;
	const name = note.path.split('/').pop() ?? note.path;
	f.name = name;
	f.basename = name.replace(/\.md$/, '');
	f.extension = 'md';
	f.stat = { ctime: 0, mtime: note.mtime ?? 0, size: 0 };
	return f;
}

export function createFakeApp(notes: FakeNote[]): FakeApp {
	const files = notes.map(makeFile);
	const fmByPath = new Map<string, Record<string, unknown> | undefined>();
	notes.forEach(n => fmByPath.set(n.path, n.frontmatter));

	const resolvedLinks: Record<string, Record<string, number>> = {};
	for (const n of notes) {
		if (n.links?.length) {
			resolvedLinks[n.path] = Object.fromEntries(n.links.map(l => [l, 1]));
		}
	}

	const existingPaths = new Set(notes.map(n => n.path));
	const createdFolders: string[] = [];

	return {
		__createdFolders: createdFolders,
		vault: {
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (p: string) =>
				existingPaths.has(p) ? (files.find(f => f.path === p) ?? null) : null,
			createFolder: async (p: string) => {
				createdFolders.push(p);
				existingPaths.add(p);
			},
		},
		metadataCache: {
			getFileCache: (f: TFile) => {
				const fm = fmByPath.get(f.path);
				return fm ? { frontmatter: fm } : null;
			},
			resolvedLinks,
		},
	};
}
