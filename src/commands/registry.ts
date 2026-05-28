import { App } from 'obsidian';
import { AIAgentSettings } from '../settings';
import { AddMessage, ReplaceMessage, AddFindResults, CommandConfig } from './slashCommands';

export interface CommandContext {
	app: App;
	settings: AIAgentSettings;
	model: string;
	config: CommandConfig;
	addMessage: AddMessage;
	replaceMessage: ReplaceMessage;
	addFindResults: AddFindResults;
	pendingImageFile?: File | null;
	clearPendingImage?: () => void;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;
const _handlers = new Map<string, Handler>();

export function register(id: string, fn: Handler): void {
	_handlers.set(id, fn);
}

/** Returns null if no handler is registered for the given command id. */
export function dispatch(id: string, args: string, ctx: CommandContext): Promise<void> | null {
	const fn = _handlers.get(id);
	return fn ? fn(args, ctx) : null;
}
