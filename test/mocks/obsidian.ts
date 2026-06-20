/**
 * Minimal stub of the `obsidian` module for unit tests.
 *
 * Vizier's source imports a handful of symbols from `obsidian` — some as types
 * (App, TFile) and some as runtime values (requestUrl, Notice, Modal classes).
 * The real package is only available inside Obsidian, so vitest aliases
 * `obsidian` to this file (see vitest.config.ts).
 *
 * Only the surface the code under test actually touches is implemented. The
 * `requestUrl` mock is a vitest spy so tests can stub network responses.
 */

import { vi } from 'vitest';

// ── Network ─────────────────────────────────────────────────────────────────
// callOllama / requestUrl callers go through this. Tests override its
// implementation per-case with `requestUrl.mockResolvedValueOnce(...)`.

export interface RequestUrlResponse {
	status: number;
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

export const requestUrl = vi.fn(
	async (_opts: unknown): Promise<RequestUrlResponse> => ({
		status: 200,
		json: {},
		text: '',
		arrayBuffer: new ArrayBuffer(0),
		headers: {},
	})
);

// ── File classes ─────────────────────────────────────────────────────────────
// TFile / TFolder are used both as types and for `instanceof` checks.

export class TAbstractFile {
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	basename = '';
	extension = 'md';
	stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

// ── UI stubs ─────────────────────────────────────────────────────────────────
// Imported by modules in the dependency graph; never exercised in unit tests.

export class Notice {
	constructor(public message: string, public timeout?: number) {}
	hide(): void {}
	setMessage(_m: string): void {}
}

export class Component {
	load(): void {}
	unload(): void {}
	registerEvent(): void {}
}

export class Modal extends Component {
	app: unknown;
	contentEl = createStubEl();
	constructor(app: unknown) { super(); this.app = app; }
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class Setting {
	constructor(_containerEl: unknown) {}
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
	addTextArea() { return this; }
	addToggle() { return this; }
	addButton() { return this; }
	addDropdown() { return this; }
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl = createStubEl();
	constructor(app: unknown, plugin: unknown) { this.app = app; this.plugin = plugin; }
	display(): void {}
	hide(): void {}
}

export class Plugin {
	app: unknown;
	manifest: unknown;
	constructor(app: unknown, manifest: unknown) { this.app = app; this.manifest = manifest; }
	addCommand(): void {}
	addRibbonIcon(): void {}
	addSettingTab(): void {}
	registerView(): void {}
	registerEvent(): void {}
	registerInterval(id: number): number { return id; }
	loadData(): Promise<unknown> { return Promise.resolve(null); }
	saveData(): Promise<void> { return Promise.resolve(); }
}

export class ItemView extends Component {
	constructor(public leaf: unknown) { super(); }
}

export class FileSystemAdapter {
	getFullPath(rel: string): string { return '/abs/' + rel; }
}

export class FuzzySuggestModal<T> extends Modal {
	getItems(): T[] { return []; }
	getItemText(_i: T): string { return ''; }
	onChooseItem(_i: T): void {}
}

export class SuggestModal<T> extends Modal {
	getSuggestions(_q: string): T[] { return []; }
}

// A tiny stand-in for an HTMLElement with the chainable Obsidian helpers.
function createStubEl(): Record<string, unknown> {
	const el: Record<string, unknown> = {};
	el.empty = () => {};
	el.createEl = () => createStubEl();
	el.createDiv = () => createStubEl();
	el.createSpan = () => createStubEl();
	el.setText = () => {};
	el.addClass = () => {};
	el.removeClass = () => {};
	el.addEventListener = () => {};
	return el;
}

// `App` is consumed only as a type in the code under test, so an interface-free
// re-export keeps TypeScript happy without a runtime class.
export type App = unknown;
export type WorkspaceLeaf = unknown;
export type CachedMetadata = unknown;
export type FrontMatterCache = Record<string, unknown>;
