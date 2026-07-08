/**
 * server_lifecycle.ts
 *
 * Decouples "I need the Vizier server" from "I own the server process".
 *
 * The plugin (main.ts) owns a TranscriptServerManager and registers an
 * ensurer here on load. Any command or agent tool that needs the local
 * Python server calls `ensureVizierServer(serverUrl)`:
 *
 *   - if the server is reachable → 'ok'
 *   - if not, and setup was done (venv exists) → auto-start it, wait for
 *     /health, return 'started' (or 'offline' if it never came up)
 *   - if setup was never run → 'no-setup' (interactive setup modal needed)
 *
 * When no ensurer is registered (tests, or very early in load) this falls
 * back to a plain reachability probe.
 */

import { requestUrl } from 'obsidian';

export type EnsureServerResult = 'ok' | 'started' | 'offline' | 'no-setup';

type Ensurer = (serverUrl: string) => Promise<EnsureServerResult>;

let _ensurer: Ensurer | null = null;

export function registerServerEnsurer(fn: Ensurer | null): void {
	_ensurer = fn;
}

/** Plain reachability probe — used when no ensurer is registered. */
export async function probeServer(serverUrl: string): Promise<boolean> {
	try {
		const res = await requestUrl({ url: `${serverUrl}/health`, throw: false });
		return res.status > 0;
	} catch {
		return false;
	}
}

/**
 * Make sure the Vizier server is up, auto-starting it when possible.
 * Never throws — callers branch on the returned status.
 */
export async function ensureVizierServer(serverUrl: string): Promise<EnsureServerResult> {
	if (_ensurer) return _ensurer(serverUrl);
	return (await probeServer(serverUrl)) ? 'ok' : 'offline';
}
