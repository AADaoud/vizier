/**
 * schemas/index.ts
 *
 * Named schema constants for every callStructured call in Vizier.
 * Rule: if code consumes the output, use a named schema here.
 *       If a human reads the output, use callStreaming — never this.
 *
 * Version bumps: add a `_v` comment beside the schema constant so trace logs
 * can record which version produced each structured output.
 */

// ── Agent loop dispatch ───────────────────────────────────────────────────

/** Single tool invocation. */
export const ToolCallSchema = { // _v1
	type: 'object',
	properties: {
		name:   { type: 'string' },
		params: { type: 'object', additionalProperties: true },
	},
	required: ['name', 'params'],
} as const;

/**
 * One agent turn: the model decides which tools to call (if any) and whether
 * it is done. The `reasoning` field is kept for traces without polluting output.
 */
export const ToolCallListSchema = { // _v1
	type: 'object',
	properties: {
		reasoning: { type: 'string' },
		calls: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:   { type: 'string' },
					params: { type: 'object', additionalProperties: true },
				},
				required: ['name', 'params'],
			},
			minItems: 0,
			maxItems: 5,
		},
		done: { type: 'boolean' },
	},
	required: ['calls', 'done'],
} as const;

// ── Memory ────────────────────────────────────────────────────────────────

/** One durable fact extracted from a conversation turn. */
export const MemoryEntrySchema = { // _v1
	type: 'object',
	properties: {
		text:       { type: 'string' },
		category:   { type: 'string', enum: ['interest', 'position', 'gap', 'reading', 'method', 'identity'] },
		confidence: { type: 'number' },
	},
	required: ['text', 'category', 'confidence'],
} as const;

/** Batch extraction: up to 2 memories per turn. */
export const MemoryExtractionSchema = { // _v1
	type: 'object',
	properties: {
		memories: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					text:       { type: 'string' },
					category:   { type: 'string', enum: ['interest', 'position', 'gap', 'reading', 'method', 'identity'] },
					confidence: { type: 'number' },
				},
				required: ['text', 'category', 'confidence'],
			},
			maxItems: 2,
		},
	},
	required: ['memories'],
} as const;

/** Dedup check: is a new memory a duplicate of an existing one? */
export const DedupDecisionSchema = { // _v1
	type: 'object',
	properties: {
		is_duplicate:  { type: 'boolean' },
		merge_into_id: { type: 'string' },
		reason:        { type: 'string' },
	},
	required: ['is_duplicate', 'reason'],
} as const;

// ── Intake / triage ───────────────────────────────────────────────────────

/** Per-item triage for feed intake pipeline. */
export const TriageResultSchema = { // _v1
	type: 'object',
	properties: {
		relevant:              { type: 'boolean' },
		score:                 { type: 'number' },
		reason:                { type: 'string' },
		tags:                  { type: 'array', items: { type: 'string' } },
		connection_to_interests: { type: 'string' },
	},
	required: ['relevant', 'score', 'reason', 'tags'],
} as const;

/** Feed items ranked by relevance to user interests. */
export const RankedItemSchema = { // _v1
	type: 'object',
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id:                      { type: 'string' },
					relevance_score:         { type: 'number' },
					connection_to_interests: { type: 'string' },
					recommended_action:      { type: 'string', enum: ['deep_read', 'skim', 'skip'] },
				},
				required: ['id', 'relevance_score', 'recommended_action'],
			},
		},
	},
	required: ['items'],
} as const;

// ── Claims & epistemic graph ──────────────────────────────────────────────

/** A factual claim extracted from a note or clip. */
export const ClaimSchema = { // _v1
	type: 'object',
	properties: {
		text:       { type: 'string' },
		confidence: { type: 'number' },
		sources:    { type: 'array', items: { type: 'string' } },
	},
	required: ['text', 'confidence', 'sources'],
} as const;

export const ClaimListSchema = { // _v1
	type: 'object',
	properties: {
		claims: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					text:       { type: 'string' },
					confidence: { type: 'number' },
					sources:    { type: 'array', items: { type: 'string' } },
				},
				required: ['text', 'confidence', 'sources'],
			},
		},
	},
	required: ['claims'],
} as const;

/** Detected contradiction between two claims. */
export const ContradictionReportSchema = { // _v1
	type: 'object',
	properties: {
		claim_a:      { type: 'string' },
		claim_b:      { type: 'string' },
		tension_type: { type: 'string', enum: ['direct_negation', 'incompatible_dates', 'conflicting_attribution', 'scope_mismatch', 'other'] },
		severity:     { type: 'string', enum: ['low', 'medium', 'high'] },
		explanation:  { type: 'string' },
	},
	required: ['claim_a', 'claim_b', 'tension_type', 'severity', 'explanation'],
} as const;

// ── Entity extraction ─────────────────────────────────────────────────────

export const EntityMentionListSchema = { // _v1
	type: 'object',
	properties: {
		entities: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:            { type: 'string' },
					type:            { type: 'string', enum: ['person', 'event', 'idea', 'organization', 'place', 'movement', 'other'] },
					exists_in_vault: { type: 'boolean' },
					significance:    { type: 'string', enum: ['stub_worthy', 'mention_only'] },
				},
				required: ['name', 'type', 'exists_in_vault', 'significance'],
			},
		},
	},
	required: ['entities'],
} as const;

// ── Source audit ──────────────────────────────────────────────────────────

export const AuditResultSchema = { // _v1
	type: 'object',
	properties: {
		uncited_claims: { type: 'array', items: { type: 'string' } },
		verdict:        { type: 'string', enum: ['clean', 'needs_citations', 'heavily_uncited'] },
		summary:        { type: 'string' },
	},
	required: ['uncited_claims', 'verdict', 'summary'],
} as const;

// ── Skills ────────────────────────────────────────────────────────────────

export const SkillDraftSchema = { // _v1
	type: 'object',
	properties: {
		title:       { type: 'string' },
		when_to_use: { type: 'string' },
		procedure:   { type: 'string' },
		pitfalls:    { type: 'string' },
		confidence:  { type: 'number' },
	},
	required: ['title', 'when_to_use', 'procedure', 'confidence'],
} as const;

// ── Gap analysis ──────────────────────────────────────────────────────────

export const GapReportSchema = { // _v1
	type: 'object',
	properties: {
		present_themes:        { type: 'array', items: { type: 'string' } },
		absent_themes:         { type: 'array', items: { type: 'string' } },
		recommended_entities:  { type: 'array', items: { type: 'string' } },
		recommended_readings:  { type: 'array', items: { type: 'string' } },
		summary:               { type: 'string' },
	},
	required: ['present_themes', 'absent_themes', 'recommended_entities', 'summary'],
} as const;

// ── Verifier ──────────────────────────────────────────────────────────────

/**
 * Verifier verdict after an effectful agent run.
 * The enum forces a binary decision the loop can act on.
 */
export const VerifierVerdictSchema = { // _v1
	type: 'object',
	properties: {
		result: { type: 'string', enum: ['SUCCESS', 'RETRY', 'BLOCKED'] },
		issues: { type: 'array', items: { type: 'string' } },
		notes:  { type: 'string' },
	},
	required: ['result', 'issues'],
} as const;

// ── Compaction ────────────────────────────────────────────────────────────

/** Self-summary produced by the context compactor. */
export const CompactionSummarySchema = { // _v1
	type: 'object',
	properties: {
		goal:          { type: 'string' },
		what_was_done: { type: 'string' },
		current_state: { type: 'string' },
		pending:       { type: 'string' },
		key_context:   { type: 'string' },
	},
	required: ['goal', 'what_was_done', 'current_state'],
} as const;

// ── TypeScript interfaces for the schemas above ───────────────────────────

export interface ToolCall {
	name: string;
	params: Record<string, unknown>;
}

export interface ToolCallList {
	reasoning?: string;
	calls: ToolCall[];
	done: boolean;
}

export interface MemoryEntry {
	text: string;
	category: 'interest' | 'position' | 'gap' | 'reading' | 'method' | 'identity';
	confidence: number;
}

export interface MemoryExtraction {
	memories: MemoryEntry[];
}

export interface DedupDecision {
	is_duplicate: boolean;
	merge_into_id?: string;
	reason: string;
}

export interface TriageResult {
	relevant: boolean;
	score: number;
	reason: string;
	tags: string[];
	connection_to_interests?: string;
}

export interface Claim {
	text: string;
	confidence: number;
	sources: string[];
}

export interface ClaimList {
	claims: Claim[];
}

export interface ContradictionReport {
	claim_a: string;
	claim_b: string;
	tension_type: 'direct_negation' | 'incompatible_dates' | 'conflicting_attribution' | 'scope_mismatch' | 'other';
	severity: 'low' | 'medium' | 'high';
	explanation: string;
}

export interface EntityMention {
	name: string;
	type: 'person' | 'event' | 'idea' | 'organization' | 'place' | 'movement' | 'other';
	exists_in_vault: boolean;
	significance: 'stub_worthy' | 'mention_only';
}

export interface EntityMentionList {
	entities: EntityMention[];
}

export interface AuditResult {
	uncited_claims: string[];
	verdict: 'clean' | 'needs_citations' | 'heavily_uncited';
	summary: string;
}

export interface SkillDraft {
	title: string;
	when_to_use: string;
	procedure: string;
	pitfalls?: string;
	confidence: number;
}

export interface GapReport {
	present_themes: string[];
	absent_themes: string[];
	recommended_entities: string[];
	recommended_readings?: string[];
	summary: string;
}

export interface VerifierVerdict {
	result: 'SUCCESS' | 'RETRY' | 'BLOCKED';
	issues: string[];
	notes?: string;
}

export interface CompactionSummary {
	goal: string;
	what_was_done: string;
	current_state: string;
	pending?: string;
	key_context?: string;
}
