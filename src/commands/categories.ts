/**
 * commands/categories.ts
 *
 * Command grouping shared by the slash-command registry, the settings UI, and
 * the chat picker. Kept dependency-free so both settings.ts and slashCommands.ts
 * can import it without creating an import cycle.
 *
 * `core` commands (write/edit/find/read) are always available and have no
 * toggle. Every other category can be switched off in settings, which hides its
 * commands from the picker and stops them dispatching (free text falls through
 * to the agent instead).
 */

export type CommandCategory =
	| 'core'
	| 'webMedia'
	| 'humanNetwork'
	| 'epistemic'
	| 'synthesis'
	| 'reflection'
	| 'ops';

export type ToggleableCategory = Exclude<CommandCategory, 'core'>;

export interface CommandCategoryInfo {
	id: ToggleableCategory;
	label: string;
	desc: string;
}

/** Display order + copy for the "Command groups" settings section. */
export const COMMAND_CATEGORIES: CommandCategoryInfo[] = [
	{ id: 'webMedia',     label: 'Web & media',      desc: 'summarize, clip, ingest, transcribe, handwriting' },
	{ id: 'humanNetwork', label: 'Human Network',    desc: 'person, event, idea, entity, link, bridge, timeline' },
	{ id: 'epistemic',    label: 'Epistemic',        desc: 'contradict, sources, gaps, research' },
	{ id: 'synthesis',    label: 'Synthesis & study', desc: 'thesis, curriculum, recluster, standardize, socratic' },
	{ id: 'reflection',   label: 'Reflection',       desc: 'weekly, monthly, freewrite' },
	{ id: 'ops',          label: 'Ops & intake',     desc: 'intake, briefing, runstats' },
];

/** All toggleable groups on by default — no behaviour change until the user opts out. */
export const DEFAULT_COMMAND_MODULES: Record<ToggleableCategory, boolean> = {
	webMedia:     true,
	humanNetwork: true,
	epistemic:    true,
	synthesis:    true,
	reflection:   true,
	ops:          true,
};

/** A category is enabled when core, or not explicitly switched off in settings. */
export function categoryEnabled(
	category: CommandCategory,
	modules: Partial<Record<ToggleableCategory, boolean>> | undefined
): boolean {
	if (category === 'core') return true;
	return modules?.[category] !== false;
}
