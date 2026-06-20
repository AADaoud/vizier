import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS } from '../src/commands/slashCommands';

// Cross-version benchmark: only the command-registry invariants that hold on
// both v0.6.5 and v0.7. The v0.7-only category system is tested separately in
// commandCategories.test.ts.

describe('SLASH_COMMANDS registry', () => {
	it('every entry has id, label, description, and template', () => {
		for (const cmd of SLASH_COMMANDS) {
			expect(cmd.id, JSON.stringify(cmd)).toBeTruthy();
			expect(cmd.label).toBeTruthy();
			expect(cmd.description).toBeTruthy();
			expect(cmd.template).toBeTruthy();
		}
	});

	it('labels are the slash form of the id', () => {
		for (const cmd of SLASH_COMMANDS) {
			expect(cmd.label).toBe('/' + cmd.id);
		}
	});

	it('templates begin with the slash label', () => {
		for (const cmd of SLASH_COMMANDS) {
			expect(cmd.template.startsWith(cmd.label)).toBe(true);
		}
	});

	it('command ids are unique', () => {
		const ids = SLASH_COMMANDS.map(c => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('still ships the core v0.6.5 commands', () => {
		const ids = new Set(SLASH_COMMANDS.map(c => c.id));
		for (const core of ['write', 'edit', 'find', 'clip', 'read', 'summarize']) {
			expect(ids.has(core), `missing /${core}`).toBe(true);
		}
	});
});
