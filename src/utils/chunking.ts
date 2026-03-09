import { callOllama } from './ollama';

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
		// Find last space within the window to avoid cutting mid-word
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
	sourceLabel: string
): Promise<string> {
	if (text.length <= THRESHOLD) {
		return callOllama({
			model,
			messages: [
				{
					role: 'user',
					content: `Summarize the following ${sourceLabel}. Provide a concise summary covering the main points.\n\nContent:\n${text}`,
				},
			],
		});
	}

	const chunks = chunkText(text, CHUNK_SIZE);

	// Map: summarize each chunk individually (serial to avoid overwhelming Ollama)
	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const summary = await callOllama({
			model,
			messages: [
				{
					role: 'user',
					content: `Summarize this section of a ${sourceLabel} in 2-3 sentences:\n\n${chunk}`,
				},
			],
		});
		chunkSummaries.push(summary);
	}

	// Reduce: combine all chunk summaries into one
	const combined = chunkSummaries.join('\n\n');
	return callOllama({
		model,
		messages: [
			{
				role: 'user',
				content: `The following are section summaries of a ${sourceLabel}. Combine them into one cohesive summary covering the main points:\n\n${combined}`,
			},
		],
	});
}
