/**
 * ui/activity.ts
 *
 * Background-activity bus — the "nothing happens invisibly" guarantee.
 *
 * Any long-running or background work (vault indexing, memory extraction,
 * skill distillation, verification, scheduler jobs) reports here, and the
 * chat view renders a slim live ticker. Items auto-expire a few seconds
 * after finishing so the bar stays quiet when nothing is happening.
 *
 * Plain module-level bus: works from non-React code (loop, scheduler, main)
 * without prop drilling.
 */

export interface ActivityItem {
	id: string;
	label: string;
	status: 'running' | 'done' | 'error';
	detail?: string;
	ts: number;
}

const _items = new Map<string, ActivityItem>();
const _listeners = new Set<() => void>();
const DONE_LINGER_MS = 4000;

function notify(): void {
	for (const fn of _listeners) fn();
}

export function onActivityChange(fn: () => void): () => void {
	_listeners.add(fn);
	return () => { _listeners.delete(fn); };
}

export function getActivities(): ActivityItem[] {
	return [..._items.values()].sort((a, b) => a.ts - b.ts);
}

/** Start (or restart) a tracked activity. */
export function beginActivity(id: string, label: string, detail?: string): void {
	_items.set(id, { id, label, status: 'running', detail, ts: Date.now() });
	notify();
}

/** Update the detail line of a running activity (e.g. progress counts). */
export function updateActivity(id: string, detail: string): void {
	const item = _items.get(id);
	if (!item) return;
	item.detail = detail;
	notify();
}

/**
 * Finish an activity. The final label/detail lingers briefly, then the item
 * disappears. Pass `silent` to remove immediately (e.g. nothing happened).
 */
export function endActivity(id: string, ok = true, finalLabel?: string, silent = false): void {
	const item = _items.get(id);
	if (!item) return;
	if (silent) {
		_items.delete(id);
		notify();
		return;
	}
	item.status = ok ? 'done' : 'error';
	if (finalLabel) { item.label = finalLabel; item.detail = undefined; }
	notify();
	window.setTimeout(() => {
		if (_items.get(id)?.status !== 'running') {
			_items.delete(id);
			notify();
		}
	}, DONE_LINGER_MS);
}
