import { register } from './registry';
import { formatRunStats } from '../traces';
import {
	executeWrite, executeEdit, executeFind, executeSummarize,
	executeClip, executeClipLearn, executeRead, executeHandwriting,
} from './slashCommands';
import {
	executeCreatePerson, executeCreateEvent, executeCreateIdea, executeCreateEntity,
	executeLink, executeBridge, executeTimeline,
} from './humanNetworkCommands';
import { executeStandardize } from './miscCommands';
import {
	executeSocratic, executeRecluster, executeContradict, executeSources,
	executeThesis, executeReflection, executeFreewrite,
} from './reflectionCommands';
import { executeIngest, executeTranscribe } from './ingestCommands';
import { executeGaps } from './gapsCommand';
import { runIntake } from '../intake/feeds';
import { generateBriefing } from '../intake/briefing';
import { getAgentPluginDir, getAgentMemoryManager, getAgentVaultIndex } from '../agent/tool_execution';
import { executeResearch, executeCurriculum } from '../research/deep_research';

register('write', (args, ctx) =>
	executeWrite(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings.aiNotesFolder)
);

register('edit', (args, ctx) =>
	executeEdit(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('find', (args, ctx) =>
	executeFind(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.addFindResults, ctx.model, ctx.config)
);

register('summarize', (args, ctx) =>
	executeSummarize(args, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('clip', (args, ctx) => {
	if (args.startsWith('learn ')) {
		return executeClipLearn(args.slice(6), ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings.clipsFolder, ctx.settings);
	}
	return executeClip(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings.clipsFolder, ctx.settings);
});

register('read', (args, ctx) =>
	executeRead(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('handwriting', (args, ctx) => {
	const file = ctx.pendingImageFile ?? null;
	if (!file) {
		ctx.addMessage('assistant', 'Paste a handwritten note image into the chat first, then send `/handwriting`.');
		return Promise.resolve();
	}
	ctx.clearPendingImage?.();
	ctx.addMessage('assistant', 'Reading image…');
	return executeHandwriting(file, ctx.app, ctx.replaceMessage, ctx.settings, ctx.config);
});

register('person', (args, ctx) =>
	executeCreatePerson(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('event', (args, ctx) =>
	executeCreateEvent(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('idea', (args, ctx) =>
	executeCreateIdea(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('link', (args, ctx) =>
	executeLink(args, ctx.app, ctx.addMessage, ctx.replaceMessage)
);

register('entity', (args, ctx) =>
	executeCreateEntity(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('bridge', (args, ctx) =>
	executeBridge(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('timeline', (args, ctx) =>
	executeTimeline(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('standardize', (args, ctx) =>
	executeStandardize(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('socratic', (args, ctx) =>
	executeSocratic(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('recluster', (args, ctx) =>
	executeRecluster(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('contradict', (args, ctx) =>
	executeContradict(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('sources', (args, ctx) =>
	executeSources(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config)
);

register('thesis', (args, ctx) =>
	executeThesis(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('weekly', (_args, ctx) =>
	executeReflection('weekly', ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('monthly', (_args, ctx) =>
	executeReflection('monthly', ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('freewrite', (args, ctx) =>
	executeFreewrite(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.settings)
);

register('ingest', (args, ctx) =>
	executeIngest(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('transcribe', (args, ctx) =>
	executeTranscribe(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.model, ctx.config, ctx.settings)
);

register('runstats', (_args, ctx) => {
	ctx.addMessage('assistant', formatRunStats(200));
	return Promise.resolve();
});

register('gaps', (args, ctx) =>
	executeGaps(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.settings)
);

register('intake', async (_args, ctx) => {
	ctx.addMessage('assistant', 'Running feed intake…');
	try {
		const r = await runIntake(
			ctx.app, ctx.settings, getAgentPluginDir(), getAgentMemoryManager(),
			msg => ctx.replaceMessage('assistant', `Running feed intake… ${msg}`)
		);
		const dest = r.notePath ? `\n\nSaved to \`${r.notePath}\`.` : '';
		ctx.replaceMessage('assistant', `Intake complete: ${r.feeds} feeds, ${r.fresh} new items, ${r.triaged} triaged, **${r.kept} kept**.${dest}`);
	} catch (err) {
		ctx.replaceMessage('assistant', `Intake failed: ${err instanceof Error ? err.message : String(err)}`);
	}
});

register('research', (args, ctx) =>
	executeResearch(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.settings, getAgentVaultIndex())
);

register('curriculum', (args, ctx) =>
	executeCurriculum(args, ctx.app, ctx.addMessage, ctx.replaceMessage, ctx.settings)
);

register('briefing', async (_args, ctx) => {
	ctx.addMessage('assistant', 'Generating briefing…');
	try {
		const notePath = await generateBriefing(ctx.app, ctx.settings, getAgentMemoryManager());
		const name = notePath.replace(/^.*\//, '').replace(/\.md$/, '');
		ctx.replaceMessage('assistant', `Briefing ready: [[${name}]]`);
	} catch (err) {
		ctx.replaceMessage('assistant', `Briefing failed: ${err instanceof Error ? err.message : String(err)}`);
	}
});
