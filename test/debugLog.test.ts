import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	initDebugLog,
	setDebugLogging,
	isDebugLogging,
	debugLogPath,
	startDebugTurn,
} from '../src/debug_log';

// NOTE: debug_log is v0.7-only (no v0.6.5 equivalent), so this suite is not part
// of the cross-version benchmark — it guards the new debug-logging feature.

let dir: string;

function logContents(): string {
	const p = debugLogPath();
	return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizier-dbg-'));
	initDebugLog(dir);
	setDebugLogging(false);
});

afterEach(() => {
	setDebugLogging(false);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('debug logging gate', () => {
	it('is off until enabled', () => {
		expect(isDebugLogging()).toBe(false);
	});

	it('reports the log path under the plugin dir', () => {
		expect(debugLogPath()).toBe(path.join(dir, 'vizier_debug.log'));
	});

	it('writes nothing while disabled', () => {
		const t = startDebugTurn('agent', 'hello');
		expect(t.active).toBe(false);
		t.log('System prompt', 'you are vizier');
		t.end('done', { ok: true });
		expect(logContents()).toBe('');
	});

	it('becomes active once enabled', () => {
		setDebugLogging(true);
		expect(isDebugLogging()).toBe(true);
		expect(startDebugTurn('agent', 'hi').active).toBe(true);
	});
});

describe('debug logging output', () => {
	beforeEach(() => setDebugLogging(true));

	it('records the turn banner, sections, and payloads', () => {
		const t = startDebugTurn('agent', 'summarize my note');
		t.log('Request', { selected_tools: ['vault_search', 'read_note'] });
		t.log('System prompt', 'You are Vizier.');
		t.end('done', { ok: true, rounds: 2 });

		const out = logContents();
		expect(out).toContain('AGENT TURN');
		expect(out).toContain('summarize my note');
		expect(out).toContain('Request');
		expect(out).toContain('vault_search');
		expect(out).toContain('You are Vizier.');
		expect(out).toContain('done');
		expect(out).toContain('"rounds": 2');
	});

	it('appends successive turns rather than overwriting', () => {
		startDebugTurn('agent', 'first').end();
		startDebugTurn('agent', 'second').end();
		const out = logContents();
		expect(out).toContain('first');
		expect(out).toContain('second');
		expect(out.match(/AGENT TURN/g)?.length).toBe(2);
	});

	it('truncates oversized fields instead of dumping everything', () => {
		startDebugTurn('agent', 'x').log('Big', 'y'.repeat(20_000));
		expect(logContents()).toContain('[truncated');
	});

	it('handles string and object payloads, and empty payloads', () => {
		const t = startDebugTurn('agent', 'x');
		t.log('JustALabel');
		t.log('StringPayload', 'plain text');
		t.log('ObjectPayload', { a: 1 });
		const out = logContents();
		expect(out).toContain('JustALabel');
		expect(out).toContain('plain text');
		expect(out).toContain('"a": 1');
	});
});
