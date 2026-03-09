import { callOllama } from './ollama';
import { Prompts } from '../prompts';

const CHUNK_SIZE = 3000;
const THRESHOLD = 4000;

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
	ollamaUrl: string
): Promise<string> {
	if (text.length <= THRESHOLD) {
		return callOllama({
			ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.summarizeFull(sourceLabel, text) }],
		});
	}

	const chunks = chunkText(text, CHUNK_SIZE);

	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const summary = await callOllama({
			ollamaUrl,
			model,
			messages: [{ role: 'user', content: Prompts.summarizeChunk(sourceLabel, chunk) }],
		});
		chunkSummaries.push(summary);
	}

	const combined = chunkSummaries.join('\n\n');
	return callOllama({
		ollamaUrl,
		model,
		messages: [{ role: 'user', content: Prompts.summarizeCombine(sourceLabel, combined) }],
	});
}
