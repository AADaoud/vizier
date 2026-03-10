import { requestUrl } from 'obsidian';

interface OllamaMessage {
	role: string;
	content: string;
}

export interface OllamaRequest {
	ollamaUrl: string;
	model: string;
	messages: OllamaMessage[];
	format?: Record<string, unknown>;
}

export async function callOllama(req: OllamaRequest): Promise<string> {
	const { ollamaUrl, ...body } = req;
	const response = await requestUrl({
		url: `${ollamaUrl}/api/chat`,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, stream: false }),
		throw: false,
	});

	if (response.status >= 400) {
		throw new Error(`Ollama request failed: HTTP ${response.status}`);
	}

	const data = response.json as { message?: { content?: string } };
	return data.message?.content ?? '';
}

export async function callOllamaStructured<T>(req: OllamaRequest): Promise<T> {
	const raw = await callOllama(req);
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`Ollama returned invalid JSON: ${raw.slice(0, 200)}`);
	}
}
