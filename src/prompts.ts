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

	// ── Handwriting OCR: cleanup pass ────────────────────────────────────────
	handwritingCleanup: (raw: string) =>
		`You are an OCR post-processor. Fix spacing, punctuation, and word splits in this raw OCR output from a handwritten note. Preserve all content and line breaks. Return only the corrected text, no commentary.\n\nRaw OCR:\n${raw}`,

	// ── Read: summarize a note ─────────────────────────────────────────────
	readSummarize: (basename: string, content: string) =>
		`You are a summarization system. Output ONLY the summary.\n\n` +
		`Summarize the note titled "${basename}" in 2-4 sentences covering the main points.\n` +
		`Do NOT evaluate or praise the note.\n\n` +
		`NOTE CONTENT:\n${content}\n\n` +
		`SUMMARY:`,

	// ── Read: answer a question about a note ───────────────────────────────
	readQuestion: (question: string, content: string) =>
		`You are a question-answering system. Output ONLY the answer.\n\n` +
		`Using the note below as context, answer this question: ${question}\n\n` +
		`Answer directly. If the answer is not in the note, say "Not found in this note."\n` +
		`Do NOT summarize the entire note. Do NOT add commentary.\n\n` +
		`NOTE CONTENT:\n${content}\n\n` +
		`ANSWER:`,
};