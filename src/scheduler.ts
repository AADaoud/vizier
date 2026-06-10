/**
 * scheduler.ts
 *
 * Proactive agency — Phase 6.1.
 *
 * A light daily cadence that runs while Obsidian is open. Every TICK the
 * scheduler checks which jobs haven't run today and fires them in order:
 *
 *   1. intake             (if features.intake and feeds configured)
 *   2. briefing           (if features.briefing — runs after intake so the
 *                          briefing sees today's items)
 *   3. contradiction scan (if any claims exist; capped per scan, so cheap)
 *
 * All outputs land in Vizier folders (inbox/contradictions) — the scheduler
 * never touches user notes. State (last run dates) lives in the plugin dir.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Notice, type App } from 'obsidian';
import type { AIAgentSettings } from './settings';
import type { MemoryManager } from './memory/memory_manager';
import { runIntake, parseFeedUrls } from './intake/feeds';
import { generateBriefing } from './intake/briefing';
import { runContradictionScan } from './epistemic/contradiction_engine';
import { getAllClaims } from './epistemic/claims';

export const TICK_MS        = 15 * 60 * 1000; // check every 15 min
export const STARTUP_DELAY  = 5 * 60 * 1000;  // let reindex/capability warmup finish first

interface SchedulerState {
	lastIntake?: string;       // YYYY-MM-DD
	lastBriefing?: string;
	lastContradiction?: string;
}

function statePath(pluginDir: string): string {
	return path.join(pluginDir, 'scheduler_state.json');
}

function loadState(pluginDir: string): SchedulerState {
	try {
		return JSON.parse(fs.readFileSync(statePath(pluginDir), 'utf-8')) as SchedulerState;
	} catch { return {}; }
}

function saveState(pluginDir: string, state: SchedulerState): void {
	try {
		fs.writeFileSync(statePath(pluginDir), JSON.stringify(state), 'utf-8');
	} catch { /* best-effort */ }
}

function todayISO(): string {
	return new Date().toISOString().slice(0, 10);
}

let _running = false;

/**
 * One scheduler tick. Exported so a manual "run daily jobs now" command can
 * reuse it (with force=true to ignore the once-per-day guard).
 */
export async function schedulerTick(
	app: App,
	settings: AIAgentSettings,
	pluginDir: string,
	memoryManager: MemoryManager | null,
	force = false
): Promise<string[]> {
	if (_running) return [];
	_running = true;
	const ran: string[] = [];

	try {
		const state = loadState(pluginDir);
		const today = todayISO();

		// 1. Intake
		if (settings.features.intake && parseFeedUrls(settings.feedUrls ?? '').length > 0
			&& (force || state.lastIntake !== today)) {
			try {
				const r = await runIntake(app, settings, pluginDir, memoryManager);
				state.lastIntake = today;
				saveState(pluginDir, state);
				ran.push(`intake (${r.kept} kept)`);
				if (r.kept > 0) new Notice(`Vizier: ${r.kept} new intake item(s) in your inbox.`, 6000);
			} catch { /* feeds down — retry next tick tomorrow */ }
		}

		// 2. Briefing
		if (settings.features.briefing && (force || state.lastBriefing !== today)) {
			try {
				const notePath = await generateBriefing(app, settings, memoryManager);
				state.lastBriefing = today;
				saveState(pluginDir, state);
				ran.push('briefing');
				const name = notePath.replace(/^.*\//, '').replace(/\.md$/, '');
				new Notice(`Vizier: daily briefing ready — ${name}`, 6000);
			} catch { /* model unavailable — try again tomorrow */ }
		}

		// 3. Contradiction scan (only when there are claims to scan)
		if ((force || state.lastContradiction !== today) && getAllClaims(app).length >= 2) {
			try {
				const r = await runContradictionScan(app, settings, pluginDir);
				state.lastContradiction = today;
				saveState(pluginDir, state);
				ran.push(`contradiction scan (${r.flagged} flagged)`);
				if (r.flagged > 0) new Notice(`Vizier: ${r.flagged} contradiction(s) flagged for review.`, 8000);
			} catch { /* skip */ }
		}
	} finally {
		_running = false;
	}

	return ran;
}
