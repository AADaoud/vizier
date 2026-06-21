/**
 * agent/tool_schemas.ts
 *
 * Every tool available to the agent: schema (name + params), keyword hints
 * for fast selection, and a rich doc section injected into the system prompt.
 *
 * Design (Odysseus §6.1): two artifacts per tool —
 *   schema  → machine-readable (name, params for dispatch)
 *   doc     → human-readable prose injected into the tool sections block
 *             with when-to-use guidance, pitfalls, and conventions
 *
 * Keyword hints power the fast pre-RAG selection layer (Phase 1.5).
 * ALWAYS_AVAILABLE tools are injected on every turn regardless.
 */

export interface ParamSchema {
	type: string;
	description?: string;
	enum?: string[];
	items?: ParamSchema;
}

export interface ToolDefinition {
	name: string;
	description: string;
	params: Record<string, ParamSchema>;
	required: string[];
	keywords: string[];
	doc: string;
	alwaysAvailable?: boolean;
}

// ── Tool catalogue ─────────────────────────────────────────────────────────

export const TOOLS: ToolDefinition[] = [

	// ── Always-available: vault I/O ───────────────────────────────────────

	{
		name: 'vault_search',
		description: 'Semantic + keyword search across all vault notes.',
		params: {
			query:  { type: 'string', description: 'Natural-language or keyword query.' },
			folder: { type: 'string', description: 'Optional: restrict search to this folder and its subfolders (e.g. "Clips" or "Human Network/People").' },
			limit:  { type: 'number', description: 'Max results (default 10, max 20).' },
		},
		required: ['query'],
		keywords: ['find', 'search', 'look for', 'do i have', 'vault', 'notes about', 'what notes'],
		alwaysAvailable: true,
		doc: `vault_search — Quick semantic lookup across the vault.
Use BEFORE claiming the vault lacks something.
Pass folder to scope the search to one directory (and its subfolders) — see VAULT STATE for the folder map.
Do NOT re-search for things already returned this turn.
Pitfall: don't use this to read a note you already have in context.`,
	},

	{
		name: 'read_note',
		description: 'Read the full content of a vault note by name or path.',
		params: {
			name:   { type: 'string', description: 'Note basename (without .md) or full vault path (e.g. "Clips/My Note").' },
			folder: { type: 'string', description: 'Optional: folder to disambiguate when several notes share the same basename.' },
		},
		required: ['name'],
		keywords: ['read', 'open', 'show me', 'content of', 'what does'],
		alwaysAvailable: true,
		doc: `read_note — Read a vault note by name.
For the note the user currently has open, use read_active_note instead.
Pass the full path as name, or set folder, when a basename is ambiguous (the tool will list candidates).
Use vault_search first to confirm the note exists.`,
	},

	{
		name: 'read_active_note',
		description: 'Read the note the user currently has open (the active note).',
		params: {},
		required: [],
		keywords: ['this note', 'active note', 'current note', 'open note', 'this page', 'this document', 'the note', 'note i', 'note im', "note i'm", 'on screen', 'in front of me'],
		alwaysAvailable: true,
		doc: `read_active_note — Load the note the user currently has open.
Call this ONLY when the user refers to what they are looking at — "this note", "the current/active note", "summarise this", "edit this page", etc.
Do NOT call it for general questions, or when the user names a specific note (use read_note for that).
Returns the active note's name and content; if nothing is open it says so.`,
	},

	{
		name: 'write_note',
		description: 'Create a new vault note with given filename and content in a chosen directory.',
		params: {
			filename: { type: 'string', description: 'Filename without .md extension.' },
			content:  { type: 'string', description: 'Full markdown content including frontmatter.' },
			folder:   { type: 'string', description: 'Target vault folder path, nested allowed (e.g. "Clips" or "Projects/2026"). Created if missing. Defaults to the configured AI notes folder.' },
		},
		required: ['filename', 'content'],
		keywords: ['write', 'create', 'new note', 'make a note', 'save'],
		alwaysAvailable: true,
		doc: `write_note — Create a new vault note in a specific directory.
For content >15 lines, always use this — never put that much in chat.
Choose folder deliberately: put the note where similar notes live (see the folder map in VAULT STATE). Omit folder only to use the default.
Include YAML frontmatter with type, created, and tags fields.
Returns the created [[wikilink]] to emit in your response.`,
	},

	{
		name: 'edit_note',
		description: 'Apply targeted FIND/REPLACE edits to an existing vault note.',
		params: {
			name:    { type: 'string', description: 'Note basename or full vault path.' },
			folder:  { type: 'string', description: 'Optional: folder to disambiguate when several notes share the same basename.' },
			find:    { type: 'string', description: 'Exact string to find (must be unique in the note).' },
			replace: { type: 'string', description: 'Replacement string.' },
		},
		required: ['name', 'find', 'replace'],
		keywords: ['edit', 'update', 'change', 'modify', 'add to', 'append', 'fix'],
		alwaysAvailable: true,
		doc: `edit_note — FIND/REPLACE edit on an existing note.
Prefer this over write_note when changing <50% of the content.
Pass the full path as name, or set folder, when a basename is ambiguous (the tool will list candidates).
The find string must be unique in the note — if ambiguous, use more surrounding context.
For the note the user has open, call read_active_note first to see its current content.`,
	},

	// ── Entity / Human Network ────────────────────────────────────────────

	{
		name: 'create_entity',
		description: 'Create a Human Network entity note (person, event, idea, organization, place, movement, or generic entity).',
		params: {
			type:    { type: 'string', enum: ['person', 'event', 'idea', 'organization', 'place', 'movement', 'entity'], description: 'Entity type.' },
			name:    { type: 'string', description: 'Entity name.' },
			context: { type: 'string', description: 'Optional extra context for generation (e.g. "Ottoman statesman, 16th century").' },
		},
		required: ['type', 'name'],
		keywords: ['person', 'people', 'who is', 'create entity', 'event', 'idea', 'organization', 'place', 'movement', 'human network'],
		doc: `create_entity — Create a structured entity note.
Use for people, historical events, concepts, organizations, and places.
The entity note is saved to the appropriate Human Network folder.
After creation, use link_entities if the entity connects to notes already in context.`,
	},

	{
		name: 'link_entities',
		description: 'Record a relationship between two Human Network entities.',
		params: {
			entity_a:     { type: 'string', description: 'First entity name.' },
			entity_b:     { type: 'string', description: 'Second entity name.' },
			relationship: { type: 'string', description: 'Relationship description (e.g. "served under", "influenced", "opposed").' },
		},
		required: ['entity_a', 'entity_b'],
		keywords: ['link', 'connect', 'relationship', 'relation', 'related to', 'between'],
		doc: `link_entities — Add a relationship edge between two entities.
Adds backlinks in both entity notes.
Both entities must already exist in the vault (create them first if needed).`,
	},

	// ── Web / external ────────────────────────────────────────────────────

	{
		name: 'wiki_lookup',
		description: 'Search Wikipedia and return a summary of the best matching article.',
		params: {
			query:    { type: 'string', description: 'Wikipedia search query.' },
			detailed: { type: 'string', enum: ['brief', 'detailed'], description: 'How much detail to return (default: brief).' },
		},
		required: ['query'],
		keywords: ['wikipedia', 'wiki', 'who was', 'what is', 'what was', 'history of', 'background on'],
		doc: `wiki_lookup — Wikipedia search and summarize.
Use when you need factual background not in the vault.
If the search returns no result, do NOT go silent — fall back to model knowledge and mark it (model knowledge — unverified).
After a successful lookup, always offer to create an entity note from the result.`,
	},

	{
		name: 'fetch_url',
		description: 'Fetch and summarize a web article or page.',
		params: {
			url:      { type: 'string', description: 'Full URL including https://.' },
			detailed: { type: 'string', enum: ['brief', 'detailed'], description: 'Summary depth (default: brief).' },
		},
		required: ['url'],
		keywords: ['fetch', 'article', 'url', 'clip', 'read this', 'summarize this url', 'http'],
		doc: `fetch_url — Fetch and summarize a web page.
Saves a Clips note automatically on success.
Pitfall: some URLs are blocked or paywalled; fall back gracefully if the fetch fails.`,
	},

	{
		name: 'summarize_media',
		description: 'Summarize a YouTube video or podcast via transcript into a Clips note.',
		params: {
			url:      { type: 'string', description: 'YouTube or podcast URL.' },
			detailed: { type: 'string', enum: ['brief', 'detailed'], description: 'brief = a concise summary (default). detailed = long-form, section-by-section notes — use when the user wants thorough notes, a lecture/long video, or says "in depth"/"detailed"/"long".' },
		},
		required: ['url'],
		keywords: ['youtube', 'video', 'podcast', 'transcript', 'watch', 'episode'],
		doc: `summarize_media — Summarize YouTube videos via transcript into a Clips note.
Pass detailed:"detailed" for long videos/lectures or when the user wants thorough notes; otherwise brief.
The note is titled with the real video title (fetched via oEmbed).
Requires the Vizier server to be running for transcript extraction.
If the server is unavailable, tell the user and suggest starting it.`,
	},

	// ── Knowledge graph operations ────────────────────────────────────────

	{
		name: 'bridge',
		description: 'Find the shortest connection path between two vault entities.',
		params: {
			entity_a: { type: 'string', description: 'Starting entity name.' },
			entity_b: { type: 'string', description: 'Target entity name.' },
		},
		required: ['entity_a', 'entity_b'],
		keywords: ['bridge', 'connection', 'path', 'relate', 'how are', 'connect'],
		doc: `bridge — Shortest-path discovery between two entities.
Traverses vault wikilinks to find how two entities are connected.
Returns the chain of intermediate notes with wikilinks.`,
	},

	{
		name: 'timeline',
		description: 'Build a chronological timeline from dated vault notes.',
		params: {
			query:    { type: 'string', description: 'Topic or keyword filter (e.g. "Ottoman Empire", "Cold War").' },
			date_range: { type: 'string', description: 'Optional date range (e.g. "1900..1950" or "1453").' },
		},
		required: ['query'],
		keywords: ['timeline', 'chronological', 'history of', 'sequence', 'when did', 'dates'],
		doc: `timeline — Chronological view of vault notes on a topic.
Pulls notes with date: frontmatter fields in the configured timeline folders.
Results are sorted by date and written as a timeline note.`,
	},

	{
		name: 'contradict_note',
		description: 'Find vault notes that contain claims contradicting the active note.',
		params: {
			note_name: { type: 'string', description: 'Note to check (defaults to active note if omitted).' },
		},
		required: [],
		keywords: ['contradict', 'contradiction', 'conflict', 'disagree', 'inconsistent', 'oppose'],
		doc: `contradict_note — Contradiction analysis against the vault.
Searches for notes whose claims directly contradict the given note.
Results are surfaced as a structured report with the conflicting excerpts cited.`,
	},

	// ── Analysis tools ────────────────────────────────────────────────────

	{
		name: 'audit_sources',
		description: 'Audit the active note for factual claims that lack citations.',
		params: {
			note_name: { type: 'string', description: 'Note to audit (defaults to active note).' },
		},
		required: [],
		keywords: ['sources', 'citations', 'audit', 'uncited', 'references', 'sourced'],
		doc: `audit_sources — Source audit for a note.
Identifies factual statements that should have citations but don't.
Returns a structured AuditResult with uncited_claims and a verdict.`,
	},

	{
		name: 'recluster',
		description: 'Cluster notes in a folder into thematic groups.',
		params: {
			folder: { type: 'string', description: 'Vault folder path to cluster.' },
			limit:  { type: 'number', description: 'Max notes to process (default: configured reclusterMaxNotes).' },
		},
		required: ['folder'],
		keywords: ['recluster', 'cluster', 'themes', 'group', 'organise', 'categorise'],
		doc: `recluster — Thematic clustering of a folder's notes.
Groups notes by semantic similarity and writes a cluster report note.
Use on Clips or any accumulation folder that has grown disorganised.`,
	},

	{
		name: 'thesis',
		description: 'Build a structured thesis/synthesis from notes matching a tag or keyword.',
		params: {
			topic: { type: 'string', description: 'Tag, keyword, or topic to gather notes for.' },
		},
		required: ['topic'],
		keywords: ['thesis', 'synthesis', 'argument', 'essay', 'structured view', 'comprehensive'],
		doc: `thesis — Multi-note synthesis into a structured argument.
Gathers all notes tagged with or about the topic, then produces a structured
thesis note with an argument, evidence, and counterarguments sections.
Uses the research role model — slower but more thorough.`,
	},

	{
		name: 'socratic',
		description: 'Generate Socratic questions for the active note to deepen understanding.',
		params: {
			note_name: { type: 'string', description: 'Note to question (defaults to active note).' },
		},
		required: [],
		keywords: ['socratic', 'questions', 'challenge', 'deeper', 'interrogate', 'probe'],
		doc: `socratic — Socratic questioning for a note.
Generates probing questions that challenge assumptions, find gaps, and deepen
engagement with the note's content. Returns 5-8 questions.`,
	},

	// ── Reflection ────────────────────────────────────────────────────────

	{
		name: 'reflection',
		description: 'Generate a weekly or monthly reflection scaffold from recent vault activity.',
		params: {
			period: { type: 'string', enum: ['weekly', 'monthly'], description: 'Reflection period.' },
		},
		required: ['period'],
		keywords: ['weekly', 'monthly', 'reflection', 'review', 'this week', 'this month'],
		doc: `reflection — Weekly or monthly synthesis.
Gathers notes modified in the period, then produces a reflection note covering
themes, open questions, and reading threads. Saved to the reflections folder.`,
	},

	// ── Ingestion ─────────────────────────────────────────────────────────

	{
		name: 'ingest_document',
		description: 'Ingest a book or document from the vault by processing it chapter by chapter.',
		params: {
			path:    { type: 'string', description: 'Vault path to the document (PDF or markdown).' },
			chapter: { type: 'number', description: 'Start from this chapter number (default: 1).' },
		},
		required: ['path'],
		keywords: ['ingest', 'book', 'document', 'pdf', 'chapter', 'process book'],
		doc: `ingest_document — Chapter-by-chapter book processing.
Produces structured notes per chapter with key claims, entities, and summaries.
Requires the Vizier server for PDF extraction.`,
	},

	{
		name: 'transcribe',
		description: 'Transcribe an audio file using Whisper.',
		params: {
			path: { type: 'string', description: 'Vault path or URL to audio file.' },
		},
		required: ['path'],
		keywords: ['transcribe', 'audio', 'whisper', 'voice note', 'recording', 'speech'],
		doc: `transcribe — Whisper transcription of an audio file.
Requires the Vizier server to be running.
Saves transcript to the transcripts folder.`,
	},

	// ── Claims & epistemic graph (Phase 3) ───────────────────────────────

	{
		name: 'add_claim',
		description: 'Record a discrete factual claim on a note (stored in frontmatter).',
		params: {
			note_name:  { type: 'string', description: 'Note to attach the claim to (defaults to active note).' },
			text:       { type: 'string', description: 'The claim as a single checkable assertion.' },
			confidence: { type: 'number', description: 'Confidence 0-1 (default 0.7).' },
			sources:    { type: 'array', description: 'Sources backing the claim (URLs or note names).', items: { type: 'string' } },
			provenance: { type: 'string', enum: ['primary', 'secondary', 'model', 'user'], description: 'Evidence tier: primary source, secondary source, model knowledge, or user assertion (default user).' },
		},
		required: ['text'],
		keywords: ['claim', 'assert', 'fact', 'record that', 'evidence'],
		doc: `add_claim — Attach a machine-readable claim to a note.
A claim is ONE checkable assertion, not a summary. Keep it under 25 words.
Uncited claims are flagged by audits — pass sources when you have them.
Set provenance honestly: 'model' for your own knowledge, 'secondary' for
articles/wiki, 'primary' only for original documents/data.
Claims power the contradiction engine: write them for anything load-bearing.`,
	},

	{
		name: 'cite_claim',
		description: 'Attach a source to an existing claim on a note.',
		params: {
			note_name: { type: 'string', description: 'Note holding the claim (defaults to active note).' },
			claim_id:  { type: 'string', description: 'Claim id (from list_claims, e.g. c_xxx).' },
			source:    { type: 'string', description: 'URL or note name that backs the claim.' },
		},
		required: ['claim_id', 'source'],
		keywords: ['cite', 'source', 'citation', 'back up', 'reference'],
		doc: `cite_claim — Add a source to a claim.
Use list_claims first to find the claim_id.`,
	},

	{
		name: 'contest_claim',
		description: 'Mark a claim as contested with a reason (e.g. it conflicts with new evidence).',
		params: {
			note_name: { type: 'string', description: 'Note holding the claim (defaults to active note).' },
			claim_id:  { type: 'string', description: 'Claim id to contest.' },
			reason:    { type: 'string', description: 'Why the claim is now in doubt.' },
		},
		required: ['claim_id', 'reason'],
		keywords: ['contest', 'dispute', 'doubt', 'challenge claim', 'wrong'],
		doc: `contest_claim — Flag a claim as contested.
Does NOT delete the claim — it stays visible with contested status so the
user can resolve it. Use when evidence conflicts, not for mere uncertainty.`,
	},

	{
		name: 'list_claims',
		description: 'List the claims recorded on a note.',
		params: {
			note_name: { type: 'string', description: 'Note to inspect (defaults to active note).' },
		},
		required: [],
		keywords: ['claims', 'list claims', 'what claims', 'assertions'],
		doc: `list_claims — Show a note's claims with ids, status, confidence, and sources.
Run this before cite_claim or contest_claim to get the claim_id.`,
	},

	{
		name: 'scan_contradictions',
		description: 'Run the contradiction engine: find claims across the vault that conflict with each other.',
		params: {},
		required: [],
		keywords: ['contradiction', 'contradictions', 'conflicts', 'scan', 'inconsistencies', 'tension'],
		doc: `scan_contradictions — Cross-vault contradiction scan over recorded claims.
Embeds all claims, finds semantically close cross-note pairs, and LLM-checks
each pair. Flags land as notes in the contradictions folder — never modifies
user notes. Only claims added via add_claim are scanned (prose is not).`,
	},

	// ── Note utilities ────────────────────────────────────────────────────

	{
		name: 'standardize_folder',
		description: 'Add missing frontmatter metadata to notes in a folder.',
		params: {
			folder: { type: 'string', description: 'Vault folder path to standardize.' },
		},
		required: ['folder'],
		keywords: ['standardize', 'metadata', 'frontmatter', 'clean up', 'missing fields'],
		doc: `standardize_folder — Metadata standardization pass.
Identifies notes with missing type, tags, or date fields and fills them in.
Processes up to 20 notes at a time to avoid rate-limiting Ollama.`,
	},

];

// ── Selection logic ───────────────────────────────────────────────────────

const ALWAYS_AVAILABLE = new Set(
	TOOLS.filter(t => t.alwaysAvailable).map(t => t.name)
);

/**
 * Select tools for this turn using keyword hints.
 * Always includes ALWAYS_AVAILABLE tools.
 * Looks at the last 3 user messages to catch "now do it for X" continuations.
 */
export function selectTools(recentUserMessages: string[]): ToolDefinition[] {
	const combined = recentUserMessages.slice(-3).join(' ').toLowerCase();
	const selected = new Set<string>(ALWAYS_AVAILABLE);

	for (const tool of TOOLS) {
		if (selected.has(tool.name)) continue;
		if (tool.keywords.some(kw => combined.includes(kw))) {
			selected.add(tool.name);
		}
	}

	return TOOLS.filter(t => selected.has(t.name));
}

export function getToolByName(name: string): ToolDefinition | undefined {
	return TOOLS.find(t => t.name === name);
}

export function getAllToolNames(): string[] {
	return TOOLS.map(t => t.name);
}
