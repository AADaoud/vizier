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
	const response = await fetch(`${ollamaUrl}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, stream: false }),
	});

	if (!response.ok) {
		throw new Error(`Ollama request failed: HTTP ${response.status}`);
	}

	const data = await response.json() as { message?: { content?: string } };
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
