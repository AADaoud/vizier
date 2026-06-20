import { describe, it, expect } from 'vitest';
import { register, dispatch, type CommandContext } from '../src/commands/registry';

// CommandContext carries app/settings/etc.; handlers under test ignore them, so
// a bare cast is enough to satisfy the signature.
const ctx = {} as CommandContext;

describe('command registry', () => {
	it('dispatch() returns null for an unregistered id', () => {
		expect(dispatch('does-not-exist', '', ctx)).toBeNull();
	});

	it('register() makes a handler dispatchable and forwards args + ctx', async () => {
		let seenArgs = '';
		let seenCtx: CommandContext | null = null;
		register('unit-echo', async (args, c) => { seenArgs = args; seenCtx = c; });

		const result = dispatch('unit-echo', 'hello there', ctx);
		expect(result).not.toBeNull();
		await result;
		expect(seenArgs).toBe('hello there');
		expect(seenCtx).toBe(ctx);
	});

	it('re-registering an id overwrites the previous handler', async () => {
		const calls: string[] = [];
		register('unit-dup', async () => { calls.push('first'); });
		register('unit-dup', async () => { calls.push('second'); });
		await dispatch('unit-dup', '', ctx);
		expect(calls).toEqual(['second']);
	});

	it('returns the handler promise so callers can await completion', async () => {
		let done = false;
		register('unit-async', async () => {
			await Promise.resolve();
			done = true;
		});
		await dispatch('unit-async', '', ctx);
		expect(done).toBe(true);
	});
});
