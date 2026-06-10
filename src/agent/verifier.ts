/**
 * agent/verifier.ts
 *
 * Verifier sub-agent — Phase 5.2.
 *
 * After an EFFECTFUL agent run (one that wrote/edited notes), a separate
 * structured call judges whether the work actually satisfied the user's
 * request. Verdicts:
 *
 *   SUCCESS — done, no action
 *   RETRY   — fixable issues; the loop gets ONE corrective round, escalated
 *             to the research model (teacher escalation)
 *   BLOCKED — needs something only the user can provide; surfaced as-is
 *
 * The verifier sees the transcript, not the vault — it checks coherence of
 * the work against the request, not ground truth.
 */

import type { LLMCoreConfig } from '../llm_core';
import { callStructured } from '../llm_core';
import { VerifierVerdictSchema, type VerifierVerdict } from '../schemas/index';

/** Tools whose execution changes the vault — only these runs get verified. */
export const EFFECTFUL_TOOLS = new Set([
	'write_note', 'edit_note', 'create_entity', 'link_entities',
	'add_claim', 'cite_claim', 'contest_claim', 'standardize_folder',
]);

export function isEffectfulRun(toolsUsed: string[]): boolean {
	return toolsUsed.some(t => EFFECTFUL_TOOLS.has(t));
}

export async function verifyRun(
	cfg: LLMCoreConfig,
	userMessage: string,
	transcript: string
): Promise<VerifierVerdict> {
	return callStructured<VerifierVerdict>(
		cfg, 'utility',
		VerifierVerdictSchema as Record<string, unknown>,
		[{
			role: 'user',
			content: [
				'You are a strict verifier for an agent that edits a personal knowledge vault.',
				'Given the user request and the agent transcript (tool calls and results), judge the outcome:',
				'- SUCCESS: the request was accomplished; tool results confirm the writes happened.',
				'- RETRY: something concrete went wrong or was missed that another round could fix (failed tool call never retried, wrong note targeted, requested content missing).',
				'- BLOCKED: the agent needs information or a decision only the user can provide.',
				'List specific issues for RETRY/BLOCKED; keep issues empty for SUCCESS.',
				'',
				`User request: ${userMessage.slice(0, 1000)}`,
				'',
				'Agent transcript:',
				transcript.slice(0, 7000),
			].join('\n'),
		}],
		{ num_predict: 400 }
	);
}
