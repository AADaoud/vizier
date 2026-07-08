import { requestUrl } from 'obsidian';
import { coerceJSON } from '../llm_core';

interface OllamaMessage {
	role: string;
	content: string;
	images?: string[]; // base64-encoded images for vision models
}

export interface OllamaRequest {
	ollamaUrl: string;
	model: string;
	messages: OllamaMessage[];
	format?: Record<string, unknown>;
	/** Disable the thinking phase (thinking models). Defaults to model behavior. */
	think?: boolean;
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

	if (response.status === 0) {
		throw new Error('Cannot reach Ollama. Make sure it is running:\n```\nollama serve\n```');
	}
	if (response.status >= 400) {
		throw new Error(`Ollama request failed: HTTP ${response.status}`);
	}

	const data = response.json as { message?: { content?: string } };
	// Thinking models may prefix prose with a <think> block — never useful downstream.
	return (data.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Structured call for the command path. Hardened the same way as
 * llm_core.callStructured: thinking disabled (it makes several models ignore
 * the `format` field or wrap output), and the response run through
 * coerceJSON, which strips ```json fences / <think> blocks and extracts the
 * JSON span — a bare JSON.parse fails on cloud/thinking models.
 */
export async function callOllamaStructured<T>(req: OllamaRequest): Promise<T> {
	const raw = await callOllama({ ...req, think: false });
	try {
		return coerceJSON<T>(raw);
	} catch {
		throw new Error(`Ollama returned invalid JSON: ${raw.slice(0, 200)}`);
	}
}
