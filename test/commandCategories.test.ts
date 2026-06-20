import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS } from '../src/commands/slashCommands';
import {
	COMMAND_CATEGORIES,
	DEFAULT_COMMAND_MODULES,
	categoryEnabled,
} from '../src/commands/categories';

// v0.7-only: the per-group command toggle system has no v0.6.5 equivalent, so
// this suite sits alongside the cross-version benchmark rather than inside it.

describe('command categories', () => {
	it('every command declares a known category', () => {
		const known = new Set<string>(['core', ...COMMAND_CATEGORIES.map(c => c.id)]);
		for (const cmd of SLASH_COMMANDS) {
			expect(known.has(cmd.category), `/${cmd.id} has unknown category ${cmd.category}`).toBe(true);
		}
	});

	it('the four core authoring commands are in the always-on "core" group', () => {
		for (const id of ['write', 'edit', 'find', 'read']) {
			expect(SLASH_COMMANDS.find(c => c.id === id)?.category).toBe('core');
		}
	});

	it('DEFAULT_COMMAND_MODULES has a (true) entry for every toggleable category', () => {
		for (const cat of COMMAND_CATEGORIES) {
			expect(DEFAULT_COMMAND_MODULES[cat.id]).toBe(true);
		}
	});

	it('every toggleable category is actually used by at least one command', () => {
		for (const cat of COMMAND_CATEGORIES) {
			expect(SLASH_COMMANDS.some(c => c.category === cat.id), `no commands in ${cat.id}`).toBe(true);
		}
	});
});

describe('categoryEnabled()', () => {
	it('core is always enabled, even with no modules configured', () => {
		expect(categoryEnabled('core', undefined)).toBe(true);
		expect(categoryEnabled('core', { humanNetwork: false } as never)).toBe(true);
	});

	it('a toggleable category is enabled unless explicitly false', () => {
		expect(categoryEnabled('epistemic', undefined)).toBe(true);   // missing → on
		expect(categoryEnabled('epistemic', {})).toBe(true);          // unset → on
		expect(categoryEnabled('epistemic', { epistemic: true })).toBe(true);
		expect(categoryEnabled('epistemic', { epistemic: false })).toBe(false);
	});

	it('disabling one group leaves others (and core) enabled', () => {
		const modules = { ...DEFAULT_COMMAND_MODULES, ops: false };
		const enabled = SLASH_COMMANDS.filter(c => categoryEnabled(c.category, modules));
		expect(enabled.some(c => c.category === 'ops')).toBe(false);
		expect(enabled.some(c => c.id === 'write')).toBe(true);          // core survives
		expect(enabled.some(c => c.category === 'epistemic')).toBe(true);
	});
});
