/**
 * Prompts optimized for deterministic output from small (4B param) models.
 * Assumes Ollama structured output mode handles JSON schema enforcement.
 *
 * Design principles:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. ROLE PRIMING — "You are a [X] system" shifts the model out of
 *    "helpful assistant" mode into tool-like behavior.
 *
 * 2. NEGATIVE CONSTRAINTS — "Do NOT explain/evaluate/praise" suppresses
 *    the critique-and-suggest reflex baked into small-model fine-tuning.
 *
 * 3. COMPLETION-STYLE ENDINGS — Prompts end with "SUMMARY:" or "ANSWER:"
 *    so the model's first token is content, not meta-commentary.
 *
 * 4. CONCISE FRAMING — Short, direct instructions. Small models lose the
 *    plot with long preambles.
 */

export const Prompts = {
	// ── Note creation ──────────────────────────────────────────────────────
	writeNote: (topic: string) =>
		`You are a note-writing system.\n\n` +
		`Create an Obsidian markdown note about: ${topic}\n\n` +
		`Rules:\n` +
		`- filename: descriptive, no extension, no slashes, kebab-case\n` +
		`- tags: 3-6 lowercase single words or hyphenated-phrases\n` +
		`- body: thorough markdown with ## headings and paragraphs\n` +
		`- Output only the requested fields, nothing else`,

	// ── Vault search: keyword expansion ────────────────────────────────────
	findQueryTerms: (query: string) =>
		`You are a search term expansion system.\n\n` +
		`Given this search query: "${query}"\n\n` +
		`Generate up to 4 alternative phrasings, abbreviations, or synonyms that this topic would literally appear as in a note title or body.\n` +
		`Rules:\n` +
		`- Each term: 1-3 words, lowercase, no punctuation\n` +
		`- Only include terms that would literally appear as text in a note\n` +
		`- Do NOT include broad categories or related topics — only direct rephrasings\n` +
		`- Example: "risc vs cisc technology" → ["reduced instruction set", "complex instruction set", "instruction set architecture", "isa"]\n` +
		`- Example: "notes on eschatology" → ["end times", "last days", "second coming", "apocalypse"]`,

	// ── Vault search: rank results ─────────────────────────────────────────
	findRankResults: (query: string, context: string) =>
		`You are a search relevance system.\n\n` +
		`User query: "${query}"\n\n` +
		`Matching notes:\n${context}\n\n` +
		`For each note, write one sentence explaining why it matches the query.\n` +
		`Write one overall summary sentence.\n` +
		`Do NOT evaluate quality. Do NOT suggest improvements.`,

	// ── Clip: metadata extraction ──────────────────────────────────────────
	clipMetadata: (summary: string) =>
		`You are a metadata extraction system.\n\n` +
		`Extract a title and tags from this web page summary:\n\n${summary.slice(0, 1000)}\n\n` +
		`Rules:\n` +
		`- title: max 60 characters, no special characters except hyphens\n` +
		`- tags: 2-5 lowercase hyphenated-phrases`,

	// ── Summarization: chunk ───────────────────────────────────────────────
	summarizeChunk: (sourceLabel: string, chunk: string) =>
		`You are a summarization system. Output ONLY the summary.\n\n` +
		`Summarize this section of a ${sourceLabel} in 2-3 sentences.\n` +
		`Do NOT evaluate the content. Do NOT comment on quality.\n\n` +
		`SECTION:\n${chunk}\n\n` +
		`SUMMARY:`,

	// ── Summarization: combine chunks ──────────────────────────────────────
	summarizeCombine: (sourceLabel: string, combined: string) =>
		`You are a summarization system. Output ONLY the combined summary.\n\n` +
		`Below are section summaries of a ${sourceLabel}. Combine them into one cohesive paragraph covering all main points.\n\n` +
		`Do NOT list strengths or weaknesses. Do NOT suggest improvements. Do NOT evaluate. Do NOT praise. Just summarize the factual content.\n\n` +
		`SECTION SUMMARIES:\n${combined}\n\n` +
		`COMBINED SUMMARY:`,

	// ── Summarization: full document ───────────────────────────────────────
	summarizeFull: (sourceLabel: string, text: string) =>
		`You are a summarization system. Output ONLY the summary.\n\n` +
		`Summarize the following ${sourceLabel} in 3-5 sentences covering the main points.\n` +
		`Do NOT evaluate. Do NOT list strengths. Do NOT suggest improvements. Do NOT praise.\n\n` +
		`CONTENT:\n${text}\n\n` +
		`SUMMARY:`,

	// ── Detailed (lecture/class) summarization: chunk ───────────────────────
	summarizeChunkDetailed: (sourceLabel: string, chunk: string) =>
		`You are a note-taking system. Output ONLY the notes.\n\n` +
		`Write detailed notes on this section of a ${sourceLabel}.\n` +
		`Capture: key concepts, definitions, examples, formulas, important details.\n` +
		`Use bullet points. Do NOT evaluate or comment on quality.\n\n` +
		`SECTION:\n${chunk}\n\n` +
		`NOTES:`,

	// ── Detailed summarization: combine chunks ─────────────────────────────
	summarizeCombineDetailed: (sourceLabel: string, combined: string) =>
		`You are a note-taking system. Output ONLY the compiled notes.\n\n` +
		`Below are detailed section notes from a ${sourceLabel}. Compile them into well-structured notes.\n` +
		`Use ## headings and bullet points. Preserve all important details.\n` +
		`Do NOT add introductions, conclusions, evaluations, or commentary.\n\n` +
		`SECTION NOTES:\n${combined}\n\n` +
		`COMPILED NOTES:`,

	// ── Detailed summarization: full document ──────────────────────────────
	summarizeFullDetailed: (sourceLabel: string, text: string) =>
		`You are a note-taking system. Output ONLY the notes.\n\n` +
		`Write comprehensive notes on the following ${sourceLabel}.\n` +
		`Use ## headings, bullet points, and include examples.\n` +
		`Cover all key concepts in enough detail for later recall.\n` +
		`Do NOT add introductions, conclusions, evaluations, or commentary.\n\n` +
		`CONTENT:\n${text}\n\n` +
		`NOTES:`,

	// ── Clip learn: study guide generation ────────────────────────
	learnStudyGuide: (summary: string) =>
		`You are a study guide generation system. Output ONLY the study guide.\n\n` +
		`Generate a study guide to help the reader understand and retain this content. Use EXACTLY this format:\n\n` +
		`## Overview\n` +
		`[Two sentences: what this is about and why it matters.]\n\n` +
		`## Key Concepts\n` +
		`**[term]**: [one-sentence definition]\n` +
		`[4-6 terms total]\n\n` +
		`## Main Takeaways\n` +
		`- [takeaway]\n` +
		`[4-5 bullet points total]\n\n` +
		`## Review Questions\n` +
		`Q: [question]? // A: [answer]\n` +
		`[exactly 3 questions, each on ONE line]\n\n` +
		`Rules:\n` +
		`- Do NOT add any text before ## Overview or after the last Q&A line\n` +
		`- Each Q&A pair must be on ONE line with " // " separating Q from A\n` +
		`- Do NOT evaluate or comment on the content\n` +
		`- Begin immediately with ## Overview\n\n` +
		`SUMMARY:\n${summary}\n\n` +
		`STUDY GUIDE:`,

	// ── Handwriting OCR ──────────────────────────────────────────────────────
	handwritingOCR: () =>
		`You are a handwriting transcription system. Output ONLY the requested JSON.\n\n` +
		`Examine the attached image and determine:\n` +
		`1. Is it a legible handwritten note? (not blurry, not a printed document, not a photo without text)\n` +
		`2. Does it contain handwritten text worth transcribing?\n` +
		`3. If both: transcribe all visible text exactly, preserving line breaks as \\n.\n\n` +
		`If the image is not legible or not a handwritten note, set transcription to "".\n` +
		`Do NOT add commentary. Output only the JSON fields.`,

	// ── Handwriting OCR: vision reconstruction pass ──────────────────────────
	handwritingReconstruct: (ocrText: string) =>
		`You are transcribing a handwritten note. The OCR engine produced this raw text:\n\n${ocrText}\n\nLook at the image and return the corrected transcription. Fix any OCR errors you can see. Preserve all content and line breaks. Return only the transcribed text, no commentary. If you cannot improve on the OCR output, return it unchanged.`,

	// ── Read: summarize a note ─────────────────────────────────────────────
	readSummarize: (basename: string, content: string) =>
		`You are a summarization system. Output ONLY the summary.\n\n` +
		`Summarize the note titled "${basename}" in 2-4 sentences covering the main points.\n` +
		`Do NOT evaluate or praise the note.\n\n` +
		`NOTE CONTENT:\n${content}\n\n` +
		`SUMMARY:`,

	// ── Edit: apply an instruction to a note ───────────────────────────────
	editNote: (instruction: string, content: string) =>
		`You are a note-editing system. Apply the following instruction to the note content and return the complete updated note.\n` +
		`Preserve the YAML front matter exactly if present. Return only the note content with no commentary.\n\n` +
		`Instruction: ${instruction}\n\n` +
		`Note:\n${content}`,

	// ── Read: answer a question about a note ───────────────────────────────
	readQuestion: (question: string, content: string) =>
		`You are a question-answering system. Output ONLY the answer.\n\n` +
		`Using the note below as context, answer this question: ${question}\n\n` +
		`Answer directly. If the answer is not in the note, say "Not found in this note."\n` +
		`Do NOT summarize the entire note. Do NOT add commentary.\n\n` +
		`NOTE CONTENT:\n${content}\n\n` +
		`ANSWER:`,

	// ── Human Network: structure a person from Wikipedia text ─────────────
	structurePerson: (name: string, extract: string) =>
		`You are a biographical data extraction system.\n\n` +
		`Extract structured fields from this Wikipedia text about "${name}".\n\n` +
		`Rules:\n` +
		`- born/died: ISO date YYYY-MM-DD or empty string if unknown\n` +
		`- nationality: array of country names\n` +
		`- roles: array of roles/occupations (e.g. ["Secretary of State", "National Security Advisor"])\n` +
		`- bio: 2 paragraph plain-text biography summarizing the key facts\n` +
		`- related_people: array of "[[Name]]" wikilinks for notable people mentioned\n` +
		`- related_events: array of "[[Event]]" wikilinks for notable events mentioned\n` +
		`- related_ideas: array of "[[Concept]]" wikilinks for ideologies or doctrines mentioned\n` +
		`- tags: 3-5 lowercase hyphenated tags\n` +
		`- Do NOT invent information not present in the text\n` +
		`- Keep wikilinks short (first + last name, no titles)\n\n` +
		`WIKIPEDIA TEXT:\n${extract}\n\nOUTPUT:`,

	// ── Human Network: structure an event from Wikipedia text ─────────────
	structureEvent: (title: string, extract: string) =>
		`You are a historical event data extraction system.\n\n` +
		`Extract structured fields from this Wikipedia text about "${title}".\n\n` +
		`Rules:\n` +
		`- date: ISO date YYYY-MM-DD when event started, or empty string if unknown\n` +
		`- date_end: ISO date YYYY-MM-DD when event ended, or empty string if ongoing/unknown\n` +
		`- location: city and country where the event primarily occurred\n` +
		`- participants: array mixing "[[Person]]" wikilinks for notable individuals and plain strings for states/organizations\n` +
		`- timeline_tags: array of broader historical contexts this belongs to (e.g. ["Cold War", "Middle East", "Nuclear Age"])\n` +
		`- significance: one of "high", "medium", or "low" based on global historical impact\n` +
		`- related_events: array of "[[Event]]" wikilinks for events mentioned\n` +
		`- related_people: array of "[[Name]]" wikilinks for people mentioned\n` +
		`- tags: 3-5 lowercase hyphenated tags\n` +
		`- Do NOT invent information not present in the text\n\n` +
		`WIKIPEDIA TEXT:\n${extract}\n\nOUTPUT:`,

	// ── Human Network: generate an idea/concept note ──────────────────────
	structureIdea: (concept: string, description: string) =>
		`You are a geopolitical concept structuring system.\n\n` +
		`Generate a structured entry for the concept "${concept}".\n\n` +
		`Rules:\n` +
		`- title: canonical name for the concept\n` +
		`- domain: array of applicable domains from [geopolitics, economics, ideology, history, philosophy, strategy, international-relations]\n` +
		`- proponents: array of "[[Person]]" wikilinks for key thinkers, leaders, or advocates\n` +
		`- period: time period as a string (e.g. "Cold War era", "19th–20th century", "Modern")\n` +
		`- related_ideas: array of "[[Concept]]" wikilinks for related theories or movements\n` +
		`- bio: 2-3 paragraph plain-text explanation of the concept, its origins, and its significance\n` +
		`- tags: 3-5 lowercase hyphenated tags\n` +
		`${description ? `User description: ${description}\n\n` : ''}OUTPUT:`,

	// ── Standardize: infer note type ──────────────────────────────────────
	standardizeType: (content: string, tags: string[]) =>
		`You are a note classification system.\n\n` +
		`Given this note content, determine its type.\n` +
		`Tags present: ${tags.join(', ') || 'none'}\n\n` +
		`NOTE (first 500 chars):\n${content.slice(0, 500)}\n\n` +
		`Choose ONE type:\n` +
		`- clip: saved web article or video summary\n` +
		`- write: AI-generated or freeform knowledge note\n` +
		`- handwriting: transcribed handwritten content\n` +
		`- person: biographical note about a real person\n` +
		`- event: historical or dated event note\n` +
		`- idea: concept, theory, or doctrine note\n` +
		`Output only the JSON field. TYPE:`,

	// ── Standardize: parse created date from note text ───────────────────
	parseCreatedDate: (excerpt: string, ctimeIso: string) =>
		`You are a date extraction system.\n\n` +
		`Extract the creation date of this note from its content. The note may contain date stamps in various formats such as:\n` +
		`- "2025-11-16 at 20:16"\n` +
		`- "202511162016" (YYYYMMDDhhmm)\n` +
		`- "November 16, 2025"\n` +
		`- "16/11/2025"\n` +
		`- Any other human-readable date format\n\n` +
		`Filesystem creation time (ctime) for context: ${ctimeIso}\n\n` +
		`NOTE EXCERPT (first 800 chars):\n${excerpt.slice(0, 800)}\n\n` +
		`Rules:\n` +
		`- If a date is clearly present in the note text, use it (it is more reliable than ctime).\n` +
		`- If no date is found in the text, fall back to the ctime date.\n` +
		`- Output ONLY the date as YYYY-MM-DD. No explanation.\n\n` +
		`DATE:`,

	// ── Entity extraction from clip summary ───────────────────────────────
	extractEntities: (summary: string) =>
		`You are an entity extraction system.\n\n` +
		`Extract named entities from this article summary. Return only entities clearly mentioned — do NOT invent.\n\n` +
		`Rules:\n` +
		`- people: real, named individuals (not organizations)\n` +
		`- events: specific named historical or current events\n` +
		`- ideas: named ideologies, theories, doctrines, or concepts\n` +
		`- name: the entity's canonical name\n` +
		`- context: one-sentence description of how this entity relates to the article\n` +
		`- Return empty arrays if no entities of that type are found\n\n` +
		`SUMMARY:\n${summary.slice(0, 2000)}\n\nOUTPUT:`,

	// ── Bridge: explain connection between two entity notes ───────────────
	bridgeHopRationale: (contentA: string, contentB: string) =>
		`You are a connection analysis system. Output ONE sentence only.\n\n` +
		`Explain the direct relationship between these two entities based on their notes.\n` +
		`Be specific. Do NOT start with "Both" or "These". State the relationship directly.\n\n` +
		`ENTITY A:\n${contentA.slice(0, 600)}\n\nENTITY B:\n${contentB.slice(0, 600)}\n\nCONNECTION:`,

	// ── Recluster: theme clustering ───────────────────────────────────────
	reclusterNotes: (representations: string) =>
		`You are a thematic clustering system.\n\n` +
		`Cluster these notes into 3-8 coherent themes. Each cluster should represent a meaningful intellectual thread, not just a topic keyword.\n\n` +
		`Rules:\n` +
		`- title: short descriptive theme name (3-5 words)\n` +
		`- moc_title: suggested Map of Content title if this theme warrants one\n` +
		`- notes: array of note titles belonging to this cluster\n` +
		`- rationale: one sentence explaining what unifies this cluster\n` +
		`- Every note must appear in exactly one cluster\n\n` +
		`NOTES:\n${representations}\n\nCLUSTERS:`,

	// ── Socratic: generate comprehension questions ────────────────────────
	socraticQuestions: (content: string) =>
		`You are a Socratic teaching system.\n\n` +
		`Generate 3-5 open-ended questions that test genuine understanding of the key claims in this note.\n` +
		`Rules:\n` +
		`- Questions must test understanding, not recall of surface facts\n` +
		`- Each question should be answerable from the note but require thinking\n` +
		`- Do NOT generate questions about trivial details\n` +
		`- Do NOT start questions with "What is" or "Who is"\n` +
		`- Return only the questions array, nothing else\n\n` +
		`NOTE:\n${content.slice(0, 3000)}\n\nQUESTIONS:`,

	// ── Extract claims ────────────────────────────────────────────────────
	extractClaims: (content: string) =>
		`You are a claim extraction system.\n\n` +
		`Identify the 3-8 load-bearing factual claims in this note — statements presented as true that could be verified or falsified.\n` +
		`Rules:\n` +
		`- Exclude opinions, questions, and observations\n` +
		`- Each claim: one declarative sentence, specific enough to be testable\n` +
		`- Do NOT include definitions, context-setting statements, or tautologies\n\n` +
		`NOTE:\n${content.slice(0, 3000)}\n\nCLAIMS:`,

	// ── Detect contradiction ──────────────────────────────────────────────
	detectContradiction: (claim: string, noteContent: string) =>
		`You are a contradiction detection system.\n\n` +
		`Does the note below contradict this claim? A contradiction means the note asserts something that cannot both be true simultaneously.\n\n` +
		`CLAIM: "${claim}"\n\n` +
		`NOTE:\n${noteContent.slice(0, 1500)}\n\n` +
		`Rules:\n` +
		`- contradicts: true only if the note makes a direct factual claim that conflicts\n` +
		`- reason: one sentence citing the specific conflicting statement, or "No contradiction found"\n` +
		`- Be strict: peripheral tension is not a contradiction\n\nOUTPUT:`,

	// ── Timeline: one-line summary for an event ───────────────────────────
	timelineSummary: (noteContent: string) =>
		`You are a timeline summarization system. Output ONE sentence only.\n\n` +
		`Summarize what happened in this event note in one sentence. Include the most significant outcome or consequence.\n` +
		`Do NOT start with the event name. Start with a verb or the main actor.\n\n` +
		`NOTE:\n${noteContent.slice(0, 1000)}\n\nSUMMARY:`,

	// ── Thesis document ───────────────────────────────────────────────────
	thesisDocument: (bundle: string) =>
		`You are a research synthesis system.\n\n` +
		`Compile the following notes into a structured thesis document. Each claim and piece of evidence must cite its source note using [[wikilink]] syntax.\n\n` +
		`Use EXACTLY this structure:\n\n` +
		`## Position\n[1-2 sentence thesis statement]\n\n` +
		`## Claims\n- [[Source]] — [claim]\n\n` +
		`## Supporting Evidence\n- [[Source]] — [evidence]\n\n` +
		`## Disconfirmers\n- [[Source]] — [counter-evidence or challenge]\n\n` +
		`## Exit Conditions\n- [condition that would change the position]\n\n` +
		`## Open Questions\n- [unresolved question]\n\n` +
		`Rules:\n` +
		`- Do NOT add text outside these sections\n` +
		`- Every bullet must cite a source\n` +
		`- Be specific; avoid vague generalities\n\n` +
		`NOTES:\n${bundle}\n\nTHESIS:`,

	// ── Reflection scaffold ───────────────────────────────────────────────
	reflectionScaffold: (themes: string, entities: string, openQuestions: string) =>
		`You are a reflection scaffolding system.\n\n` +
		`Generate a weekly reflection document using only the data provided. Do NOT invent content.\n\n` +
		`Use EXACTLY this structure. Fill model-generated sections from the data. Leave user sections empty.\n\n` +
		`## Themes you returned to\n[list themes with note counts, from data]\n\n` +
		`## Entities you encountered\n[list people/events/ideas with frequency, from data]\n\n` +
		`## Questions left open\n[extract unresolved questions or incomplete threads from notes]\n\n` +
		`## What surprised you\n*(your reflection here)*\n\n` +
		`## What you want to revisit\n*(your reflection here)*\n\n` +
		`## Free reflection\n*(your reflection here)*\n\n` +
		`DATA:\nThemes: ${themes}\nEntities: ${entities}\nOpen questions from notes: ${openQuestions}\n\nSCAFFOLD:`,

	// ── Ingest: per-chapter processing ────────────────────────────────────
	ingestChapter: (title: string, content: string) =>
		`You are a book chapter processing system.\n\n` +
		`Process this chapter and return structured notes.\n\n` +
		`Rules:\n` +
		`- summary: 2-3 sentence overview of what this chapter covers\n` +
		`- claims: 3-5 key factual claims or arguments made in the chapter\n` +
		`- questions: 3 review questions that test understanding of this chapter\n\n` +
		`CHAPTER: ${title}\n\n${content.slice(0, 4000)}\n\nOUTPUT:`,

	// ── Sources: find uncited claims ──────────────────────────────────────
	sourcesUncited: (content: string) =>
		`You are a citation audit system.\n\n` +
		`Identify factual claims in this note that lack a citation. A citation means a [[wikilink]], URL, footnote, or explicit attribution nearby.\n\n` +
		`Rules:\n` +
		`- Only flag specific, objectively verifiable factual claims\n` +
		`- Do NOT flag opinions, observations, questions, or definitions\n` +
		`- Do NOT flag claims that have a wikilink, URL, or "according to X" attribution within the same sentence or adjacent bullet\n` +
		`- Return empty array if all claims appear cited\n\n` +
		`NOTE:\n${content.slice(0, 3000)}\n\nUNCITED CLAIMS:`,
};