import { callOllama } from './ollama';
import { Prompts } from '../prompts';

const CHUNK_SIZE = 3000;
const THRESHOLD = 4000;

const SYSTEM_NOTE_TAKER = {
	role: 'system' as const,
	content:
		'You are Vizier, a note-taking and summarization system. You are not a conversational assistant.\n\n' +
		'Rules you must follow:\n' +
		'- Output ONLY the requested content — notes, summaries, or structured data\n' +
		'- NEVER include: greetings, acknowledgments, preamble, praise, critique, suggestions for improvement, follow-up questions, or sign-offs\n' +
		'- NEVER evaluate or comment on the quality of the source material\n' +
		'- NEVER use phrases like "Here is", "Sure!", "Great question", "This is a", "I hope this helps"\n' +
		'- Begin your response immediately with the substance\n' +
		'- If the prompt ends with a label like "SUMMARY:" or "NOTES:", continue directly from that label',
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
	detailed = false,
	onStatus?: (msg: string) => void
): Promise<string> {
	if (text.length <= THRESHOLD) {
		onStatus?.('Generating summary…');
		const prompt = detailed
			? Prompts.summarizeFullDetailed(sourceLabel, text)
			: Prompts.summarizeFull(sourceLabel, text);
		return callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: prompt }] });
	}

	const chunks = chunkText(text, CHUNK_SIZE);
	onStatus?.(`Chunking text into ${chunks.length} segments…`);

	const chunkSummaries: string[] = [];
	for (const [i, chunk] of chunks.entries()) {
		onStatus?.(`Summarizing segment ${i + 1} / ${chunks.length}…`);
		const prompt = detailed
			? Prompts.summarizeChunkDetailed(sourceLabel, chunk)
			: Prompts.summarizeChunk(sourceLabel, chunk);
		const summary = await callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: prompt }] });
		chunkSummaries.push(summary);
	}

	onStatus?.('Combining summaries…');
	const combined = chunkSummaries.join('\n\n');
	const combinePrompt = detailed
		? Prompts.summarizeCombineDetailed(sourceLabel, combined)
		: Prompts.summarizeCombine(sourceLabel, combined);
	return callOllama({ ollamaUrl, model, messages: [SYSTEM_NOTE_TAKER, { role: 'user', content: combinePrompt }] });
}
