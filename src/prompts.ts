export const Prompts = {
	writeNote: (topic: string) =>
		`Create a well-structured Obsidian markdown note about: ${topic}\n\n` +
		`Provide a descriptive filename (no extension, no path separators), ` +
		`relevant tags as an array of single lowercase words or hyphenated-phrases (no spaces, no special characters), ` +
		`and detailed content for the body field. The body should use markdown headings and be thorough.`,

	findQueryTerms: (query: string) =>
		`Given this natural language vault search query: "${query}"\n\n` +
		`Generate 3-6 short keyword search terms that would surface relevant notes. ` +
		`Return only the terms array. Each term should be 1-3 words, lowercase, no punctuation.`,

	findRankResults: (query: string, context: string) =>
		`The user searched their Obsidian vault for: "${query}"\n\n` +
		`Matching notes:\n${context}\n\n` +
		`For each note listed above, provide a short one-sentence relevance note explaining why it matches. Keep overall summary under 2 sentences.`,

	clipMetadata: (summary: string) =>
		`Given this summary of a web page, provide a concise title (max 60 chars, no special characters except hyphens) ` +
		`and 2-5 relevant tags. Tags must be lowercase hyphenated-phrases only — no spaces, no special characters.\n\nSummary:\n${summary.slice(0, 1000)}`,

	summarizeChunk: (sourceLabel: string, chunk: string) =>
		`Summarize this section of a ${sourceLabel} in 2-3 sentences. Output only the summary.\n\n${chunk}`,

	summarizeCombine: (sourceLabel: string, combined: string) =>
		`The following are section summaries of a ${sourceLabel}. Combine them into one cohesive summary covering the main points. Output only the summary.\n\n${combined}`,

	summarizeFull: (sourceLabel: string, text: string) =>
		`Summarize the following ${sourceLabel}. Output only the summary covering the main points.\n\nContent:\n${text}`,

	// ── Detailed (lecture/class) summarization ─────────────────────────────
	summarizeChunkDetailed: (sourceLabel: string, chunk: string) =>
		`Write detailed notes on this section of a ${sourceLabel}. Capture key concepts, definitions, examples, formulas, and any detail worth remembering. Output only the notes.\n\n${chunk}`,

	summarizeCombineDetailed: (sourceLabel: string, combined: string) =>
		`The following are detailed section notes from a ${sourceLabel}. Compile them into well-structured notes using markdown headings (##) and bullet points. Preserve all important details. Output only the compiled notes.\n\n${combined}`,

	summarizeFullDetailed: (sourceLabel: string, text: string) =>
		`Write comprehensive notes on the following ${sourceLabel}. Use markdown headings (##), bullet points, and examples. Cover all key concepts in sufficient detail for later recall. Output only the notes.\n\nContent:\n${text}`,

	readSummarize: (basename: string, content: string) =>
		`Summarize the following note titled "${basename}". Cover the main points concisely.\n\nContent:\n${content}`,

	readQuestion: (question: string, content: string) =>
		`Using the following note as context, answer this question: ${question}\n\nNote content:\n${content}`,
};
