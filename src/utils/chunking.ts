import { callOllama } from './ollama';
import { Prompts } from '../prompts';

const CHUNK_SIZE = 3000;
const THRESHOLD = 4000;

const SYSTEM_NOTE_TAKER = {
	role: 'system' as const,
	content: 'You are a note-taking assistant. Output only the requested notes or summary — no acknowledgments, preamble, introductory phrases, or follow-up questions. Begin your response immediately with the content.',
};

export function chunkText(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];

	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		const end = start + maxChars;
		if (end >= text.length) {
			chunks.push(text.slice(start));
			break;
		}
		const lastSpace = text.lastIndexOf(' ', end);
		const splitAt = lastSpace > start ? lastSpace : end;
		chunks.push(text.slice(start, splitAt).trim());
		start = splitAt + 1;
	}

	return chunks.filter(c => c.length > 0);
}

export async function mapReduceSummarize(
	text: string,
	model: string,
	sourceLabel: string,
	ollamaUrl: string,
	detailed = false
): Promise<string> {
	if (text.length <= THRESHOLD) {
		const prompt = detailed
			? Prompts.summarizeFullDetailed(sourceLabel, text)
			: Prompts.summarizeFull(sourceLabel, text);
		return callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: prompt }] });
	}

	const chunks = chunkText(text, CHUNK_SIZE);

	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const prompt = detailed
			? Prompts.summarizeChunkDetailed(sourceLabel, chunk)
			: Prompts.summarizeChunk(sourceLabel, chunk);
		const summary = await callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: prompt }] });
		chunkSummaries.push(summary);
	}

	const combined = chunkSummaries.join('\n\n');
	const combinePrompt = detailed
		? Prompts.summarizeCombineDetailed(sourceLabel, combined)
		: Prompts.summarizeCombine(sourceLabel, combined);
	return callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: combinePrompt }] });
}
