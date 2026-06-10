/**
 * agent/loop.ts
 *
 * Multi-round agent loop — the heart of Phase 1.
 *
 * Flow per round:
 *   1. Build system prompt (layered blocks)
 *   2. Call LLM with ToolCallListSchema (structured primary path)
 *      → Fallback: fenced JSON parser if model lacks structured output support
 *   3. For each tool call: validate params → execute → inject result
 *   4. Loop-breaker: if the same tool+params appeared last round, skip tools and force prose
 *   5. If done=true or MAX_ROUNDS reached: stream final prose response
 *
 * Events emitted to the caller via `onEvent`:
 *   token       → stream a text token to the chat
 *   tool_start  → show a "calling X" chip
 *   tool_result → show a "done / error" chip
 *   error       → terminal failure
 */

import type { App } from 'obsidian';
import type { AIAgentSettings } from '../settings';
import type { LLMMessage } from '../llm_core';
import {
	buildLLMConfig,
	callStructured,
	callStreaming,
	estimateTokens,
	getContextWindow,
} from '../llm_core';
import {
	buildSystemPrompt,
	invalidateVaultCache,
} from './prompt_builder';
import {
	selectTools,
} from './tool_schemas';
import {
	executeTool,
	validateParams,
} from './tool_execution';
import { loadSkills, selectSkills, formatSkillsBlock, distillSkill } from '../skills/skills';
import { verifyRun, isEffectfulRun } from './verifier';
import { beginActivity, endActivity } from '../ui/activity';
import {
	ToolCallListSchema,
	CompactionSummarySchema,
	type ToolCallList,
	type CompactionSummary,
} from '../schemas/index';
import { recordRun } from '../traces';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ROUNDS        = 12;
const TOOL_RESULT_CAP   = 10_000; // chars — truncate verbose tool outputs
const COMPACTION_THRESH = 0.85;   // compact when >85% of context window used

// ── Event types ────────────────────────────────────────────────────────────

export interface AgentEventToken      { type: 'token';       content: string }
export interface AgentEventToolStart  { type: 'tool_start';  name: string; params: Record<string, unknown> }
export interface AgentEventToolResult { type: 'tool_result'; name: string; preview: string; output: string; ok: boolean; duration_ms: number }
export interface AgentEventRoundEnd   { type: 'round_end';   round: number }
export interface AgentEventError      { type: 'error';       message: string }
/** Run metadata: which model is answering. Emitted once at run start. */
export interface AgentEventMeta       { type: 'meta';        model: string }

export type AgentEvent =
	| AgentEventToken
	| AgentEventToolStart
	| AgentEventToolResult
	| AgentEventRoundEnd
	| AgentEventError
	| AgentEventMeta;

// ── Conversation message (richer than LLMMessage) ─────────────────────────

export interface ConversationMessage {
	role: 'user' | 'assistant';
	content: string;
}

// ── Chitchat fast-path ─────────────────────────────────────────────────────
// Small models reliably over-trigger tools on greetings ("hello" → read the
// active note and summarise it). Rules in the prompt don't restrain a 2B
// model, so catch trivial conversational openers deterministically and skip
// tool dispatch entirely.

const CHITCHAT_RE = /^(hi|hello|hey|yo|salam|salaam|selam|good (morning|afternoon|evening)|thanks?|thank you|ok(ay)?|cool|nice|great|bye|goodbye|how are you\??|what'?s up\??)[.!\s]*$/i;

function isChitchat(message: string): boolean {
	return message.trim().length <= 40 && CHITCHAT_RE.test(message.trim());
}

// ── Loop-breaker state ─────────────────────────────────────────────────────

function toolCallKey(name: string, params: Record<string, unknown>): string {
	return `${name}:${JSON.stringify(params)}`;
}

// ── Context compaction ────────────────────────────────────────────────────

async function maybeCompact(
	messages: LLMMessage[],
	settings: AIAgentSettings,
	contextWindow: number
): Promise<LLMMessage[]> {
	const usage = estimateTokens(messages);
	if (usage < contextWindow * COMPACTION_THRESH) return messages;

	const cfg = buildLLMConfig(settings);
	const toSummarize = messages.filter(m => m.role !== 'system').slice(0, -4); // keep last 4 exchanges intact
	if (toSummarize.length < 4) return messages;

	try {
		const summary = await callStructured<CompactionSummary>(
			cfg,
			'utility',
			CompactionSummarySchema as Record<string, unknown>,
			[
				...messages.filter(m => m.role === 'system').slice(0, 1), // just the preamble
				{
					role: 'user',
					content: 'Summarise this conversation so far in the CompactionSummary schema:\n\n' +
						toSummarize.map(m => `${m.role}: ${m.content}`).join('\n\n'),
				},
			]
		);

		const summaryText = [
			'## Compacted conversation',
			`**Goal:** ${summary.goal}`,
			`**Done so far:** ${summary.what_was_done}`,
			`**Current state:** ${summary.current_state}`,
			summary.pending ? `**Pending:** ${summary.pending}` : '',
			summary.key_context ? `**Key context:** ${summary.key_context}` : '',
		].filter(Boolean).join('\n');

		// Keep system messages + compacted summary + last 4 exchanges
		const systemMsgs = messages.filter(m => m.role === 'system');
		const recent     = messages.filter(m => m.role !== 'system').slice(-4);

		return [
			...systemMsgs,
			{ role: 'assistant', content: summaryText },
			...recent,
		];
	} catch {
		// Compaction failed — continue with full context rather than crashing
		return messages;
	}
}

// ── Fenced JSON fallback parser ────────────────────────────────────────────
// For models that don't support Ollama's structured output format field.

function parseFencedToolCalls(text: string): ToolCallList | null {
	// Match ```tool_call ... ``` blocks (and a few aliases the model might use)
	const fenceRe = /```(?:tool_call|toolcall|tool|json_tool)\s*([\s\S]*?)```/gi;
	const calls: ToolCallList['calls'] = [];
	let match: RegExpExecArray | null;

	while ((match = fenceRe.exec(text)) !== null) {
		try {
			const parsed = JSON.parse(match[1]?.trim() ?? '') as { name?: string; params?: Record<string, unknown> };
			if (parsed.name) {
				calls.push({ name: parsed.name, params: parsed.params ?? {} });
			}
		} catch { /* skip malformed block */ }
	}

	if (calls.length === 0) return null;
	// Treat as not-done if tools were found — the model probably wants to keep going
	return { calls, done: false };
}

// ── Main agent loop ────────────────────────────────────────────────────────

export async function runAgentLoop(
	userMessage: string,
	history: ConversationMessage[],
	app: App,
	settings: AIAgentSettings,
	onEvent: (event: AgentEvent) => void,
	memories: Array<{ text: string; category: string }> = []
): Promise<void> {
	const startTime  = Date.now();
	const cfg        = buildLLMConfig(settings);
	const toolsUsed: string[] = [];
	let   ok         = true;
	let   errorMsg   = '';
	let   verifierResult: string | undefined;
	let   anyFallback = false;

	// Collect recent user messages for keyword-based tool selection
	const recentUserMsgs = [
		...history.filter(m => m.role === 'user').slice(-2).map(m => m.content),
		userMessage,
	];
	const selectedTools = selectTools(recentUserMsgs);

	// Learned skills matching this request (Phase 5)
	let skillsMarkdown = '';
	try {
		const matched = selectSkills(await loadSkills(app, settings), recentUserMsgs);
		skillsMarkdown = formatSkillsBlock(matched);
	} catch { /* skills folder unreadable — proceed without */ }

	// Build layered system prompt
	const systemMessages = await buildSystemPrompt({
		app,
		settings,
		selectedTools,
		memories,
		includeActiveNote: true,
		skillsMarkdown,
	});

	// Discover context window for this model
	const primaryModel = cfg.roles.default.models[0] ?? 'gemma3:4b';
	const contextWindow = await getContextWindow(cfg.ollamaUrl, primaryModel);
	onEvent({ type: 'meta', model: primaryModel });

	// Assemble the conversation so far
	let messages: LLMMessage[] = [
		...systemMessages,
		...history.map(m => ({ role: m.role, content: m.content } as LLMMessage)),
		{ role: 'user', content: userMessage },
	];

	const lastToolKeys = new Set<string>(); // loop-breaker state
	let round = 0;
	let forceProseRound = false; // set by loop-breaker

	// Greetings/small talk: skip tool dispatch, go straight to a prose reply
	if (isChitchat(userMessage)) forceProseRound = true;

	try {
		while (round < MAX_ROUNDS) {
			round++;

			// ── Compact if needed ──────────────────────────────────────
			messages = await maybeCompact(messages, settings, contextWindow);

			// ── Skip tool dispatch on force-prose round ────────────────
			if (forceProseRound) break;

			// ── Tool dispatch: structured primary path ─────────────────
			let toolList: ToolCallList | null = null;
			let usedFallback = false;

			try {
				toolList = await callStructured<ToolCallList>(
					cfg,
					'default',
					ToolCallListSchema as Record<string, unknown>,
					messages,
					{ temperature: 0 }
				);
			} catch {
				// Structured call failed — try fenced fallback via non-streaming call
				try {
					let rawText = '';
					await callStreaming(cfg, 'default', [
						...messages,
						{
							role: 'user',
							content: 'Decide if you need any tools. If yes, respond with ```tool_call\n{"name":"<tool>","params":{...}}\n```. If no, just respond with DONE.',
						},
					], { temperature: 0 }, t => { rawText += t; });
					toolList = parseFencedToolCalls(rawText);
					if (!toolList) toolList = { calls: [], done: true };
					usedFallback = true;
				} catch {
					toolList = { calls: [], done: true };
					usedFallback = true;
				}
				if (usedFallback) anyFallback = true;
			}

			onEvent({ type: 'round_end', round });

			// ── Loop-breaker ───────────────────────────────────────────
			const currentToolKeys = new Set(toolList.calls.map(c => toolCallKey(c.name, c.params)));
			const allRepeat = toolList.calls.length > 0 && toolList.calls.every(c => lastToolKeys.has(toolCallKey(c.name, c.params)));
			if (allRepeat) {
				forceProseRound = true;
				messages.push({
					role: 'user',
					content: '[SYSTEM] You called the same tools with the same params as the previous round. The loop-breaker has fired. Do NOT call any more tools. Summarise what you know and respond to the user directly.',
				});
				break;
			}
			lastToolKeys.clear();
			for (const key of currentToolKeys) lastToolKeys.add(key);

			// ── Execute tool calls ─────────────────────────────────────
			const toolResultLines: string[] = [];
			const validCalls = toolList.calls.filter(call => {
				const err = validateParams(call);
				if (err) {
					const msg = `${err.error}${err.missing ? ` — missing params: ${err.missing.join(', ')}` : ''}`;
					toolResultLines.push(`TOOL ${call.name} ERROR: ${msg}`);
					onEvent({ type: 'tool_result', name: call.name, preview: `Error: ${err.error}`, output: msg, ok: false, duration_ms: 0 });
					return false;
				}
				return true;
			});

			for (const call of validCalls) {
				onEvent({ type: 'tool_start', name: call.name, params: call.params });

				const result = await executeTool(call, app, settings);

				const preview = result.output.slice(0, 120).replace(/\n/g, ' ');
				onEvent({ type: 'tool_result', name: call.name, preview, output: result.output.slice(0, 4000), ok: result.ok, duration_ms: result.duration_ms });

				if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);

				// Cap verbose output
				const capped = result.output.length > TOOL_RESULT_CAP
					? result.output.slice(0, TOOL_RESULT_CAP) + `\n[… output capped at ${TOOL_RESULT_CAP} chars]`
					: result.output;

				toolResultLines.push(`TOOL ${call.name} ${result.ok ? 'SUCCESS' : 'ERROR'}:\n${capped}`);
			}

			if (toolResultLines.length > 0) {
				messages.push({
					role: 'user',
					content: toolResultLines.join('\n\n---\n\n'),
				});
			}

			// ── Done? ──────────────────────────────────────────────────
			if (toolList.done && toolList.calls.length === 0) break;
			if (toolList.done) break; // tools executed, now stream prose below

			// If no tools were called and not done, model should have responded in prose — stream it
			if (toolList.calls.length === 0) break;
		}

		// ── Stream final prose response ────────────────────────────────
		await callStreaming(
			cfg,
			'default',
			messages,
			{ temperature: 0.7 },
			token => onEvent({ type: 'token', content: token })
		);

		invalidateVaultCache(); // vault may have changed if notes were written

		const transcript = () => messages
			.filter(m => m.role !== 'system')
			.map(m => `${m.role}: ${m.content}`)
			.join('\n\n');

		// ── Verifier (Phase 5): one corrective round on effectful runs ─
		if (isEffectfulRun(toolsUsed)) {
			beginActivity('verify', 'Verifying the work');
			try {
				const verdict = await verifyRun(cfg, userMessage, transcript());
				verifierResult = verdict.result;
				endActivity('verify', verdict.result !== 'BLOCKED',
					verdict.result === 'SUCCESS' ? 'Work verified'
						: verdict.result === 'RETRY' ? 'Issues found — correcting'
						: 'Verifier: blocked');

				if (verdict.result === 'RETRY' && verdict.issues.length > 0) {
					messages.push({
						role: 'user',
						content: `[VERIFIER] The work has unresolved issues:\n${verdict.issues.map(i => `- ${i}`).join('\n')}\nFix them now with the necessary tool calls. Do not apologise — just fix.`,
					});

					// Teacher escalation: the corrective dispatch goes to the
					// research role (stronger model than the one that erred)
					const fix = await callStructured<ToolCallList>(
						cfg, 'research',
						ToolCallListSchema as Record<string, unknown>,
						messages, { temperature: 0 }
					);

					const fixResults: string[] = [];
					for (const call of fix.calls.slice(0, 5)) {
						if (validateParams(call)) continue;
						onEvent({ type: 'tool_start', name: call.name, params: call.params });
						const r = await executeTool(call, app, settings);
						onEvent({ type: 'tool_result', name: call.name, preview: r.output.slice(0, 120).replace(/\n/g, ' '), output: r.output.slice(0, 4000), ok: r.ok, duration_ms: r.duration_ms });
						if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
						fixResults.push(`TOOL ${call.name} ${r.ok ? 'SUCCESS' : 'ERROR'}:\n${r.output.slice(0, TOOL_RESULT_CAP)}`);
					}

					if (fixResults.length > 0) {
						messages.push({ role: 'user', content: fixResults.join('\n\n---\n\n') + '\n\nBriefly tell the user what was corrected.' });
						onEvent({ type: 'token', content: '\n\n' });
						await callStreaming(cfg, 'default', messages, { temperature: 0.7 },
							token => onEvent({ type: 'token', content: token }));
						invalidateVaultCache();
					}
				}
			} catch { endActivity('verify', true, undefined, true); /* verification is best-effort */ }
		}

		// ── Skill distillation (Phase 5): learn from multi-step successes ─
		if (round >= 2 && toolsUsed.length >= 2) {
			const t = transcript();
			beginActivity('skill', 'Distilling a skill from this session');
			void distillSkill(app, settings, t, toolsUsed).then(notePath => {
				if (notePath) {
					const name = notePath.replace(/^.*\//, '').replace(/\.md$/, '');
					endActivity('skill', true, `Skill learned: ${name}`);
				} else {
					endActivity('skill', true, undefined, true); // nothing reusable — vanish quietly
				}
			}).catch(() => endActivity('skill', true, undefined, true));
		}

	} catch (err) {
		ok = false;
		errorMsg = err instanceof Error ? err.message : String(err);
		onEvent({ type: 'error', message: errorMsg });
	} finally {
		recordRun({
			kind: 'agent',
			model: primaryModel,
			duration_ms: Date.now() - startTime,
			tools_used: toolsUsed,
			ok,
			error: errorMsg || undefined,
			rounds: round,
			verifier: verifierResult,
			fallback: anyFallback,
		});
	}
}
