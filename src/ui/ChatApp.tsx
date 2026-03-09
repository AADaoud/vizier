import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context';
import {
	SLASH_COMMANDS,
	SlashCommand,
	executeWrite,
	executeFind,
	executeSummarize,
} from '../commands/slashCommands';

interface Message {
	role: 'user' | 'assistant';
	content: string;
}

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const DEFAULT_MODEL = 'gemma3:4b';

function getCommandFilter(input: string): string | null {
	if (!input.startsWith('/')) return null;
	const space = input.indexOf(' ');
	return space === -1 ? input.slice(1) : null; // only show picker while no space yet
}

function parseCommand(input: string): { id: string; args: string } | null {
	if (!input.startsWith('/')) return null;
	const space = input.indexOf(' ');
	if (space === -1) return { id: input.slice(1), args: '' };
	return { id: input.slice(1, space), args: input.slice(space + 1) };
}

export const ChatApp = () => {
	const app = useApp();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState('');
	const [loading, setLoading] = useState(false);
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [pickerIndex, setPickerIndex] = useState(0);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, loading]);

	const commandFilter = getCommandFilter(input);
	const visibleCommands: SlashCommand[] =
		commandFilter !== null
			? SLASH_COMMANDS.filter(c => c.id.startsWith(commandFilter.toLowerCase()))
			: [];
	const showPicker = visibleCommands.length > 0;

	// Reset picker selection when filtered list changes
	useEffect(() => {
		setPickerIndex(0);
	}, [commandFilter]);

	const addMessage = useCallback((role: 'user' | 'assistant', content: string) => {
		setMessages(prev => [...prev, { role, content }]);
	}, []);

	const sendToOllama = useCallback(async (history: Message[], userContent: string) => {
		setLoading(true);
		const prompt = userContent;
		const allMessages = [...history, { role: 'user' as const, content: prompt }];
		try {
			const response = await fetch(OLLAMA_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					messages: allMessages.map(m => ({ role: m.role, content: m.content })),
					stream: false,
				}),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json() as { message?: { content?: string } };
			addMessage('assistant', data.message?.content ?? '(no response)');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			addMessage('assistant', `Error: ${msg}`);
		} finally {
			setLoading(false);
		}
	}, [model, addMessage]);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || loading) return;
		setInput('');

		const parsed = parseCommand(text);

		if (parsed) {
			addMessage('user', text);

			if (parsed.id === 'write') {
				setLoading(true);
				try {
					await executeWrite(parsed.args, app, addMessage, model);
				} finally {
					setLoading(false);
				}
				return;
			}

			if (parsed.id === 'find') {
				setLoading(true);
				try {
					await executeFind(parsed.args, app, addMessage, model);
				} finally {
					setLoading(false);
				}
				return;
			}

			if (parsed.id === 'summarize') {
				setLoading(true);
				try {
					await executeSummarize(parsed.args, addMessage, model);
				} finally {
					setLoading(false);
				}
				return;
			}

			addMessage('assistant', `Unknown command \`/${parsed.id}\`. Available: /write, /find, /summarize`);
			return;
		}

		// Regular chat message
		const userMsg: Message = { role: 'user', content: text };
		const history = [...messages, userMsg];
		setMessages(history);
		await sendToOllama(messages, text);
	}, [input, loading, messages, app, addMessage, sendToOllama]);

	const selectCommand = (cmd: SlashCommand) => {
		setInput(cmd.template);
		textareaRef.current?.focus();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (showPicker) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setPickerIndex(i => Math.min(i + 1, visibleCommands.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setPickerIndex(i => Math.max(i - 1, 0));
				return;
			}
			if (e.key === 'Tab' || (e.key === 'Enter' && visibleCommands.length > 0 && !input.includes(' '))) {
				e.preventDefault();
				const cmd = visibleCommands[pickerIndex];
				if (cmd) selectCommand(cmd);
				return;
			}
			if (e.key === 'Escape') {
				setInput('');
				return;
			}
		}

		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void handleSend();
		}
	};

	return (
		<div className="ai-chat-container">
			<div className="ai-chat-header">
				<span className="ai-chat-title">AI Agent</span>
				<span className="ai-chat-vault">{app.vault.getName()}</span>
				<input
					className="ai-chat-model-input"
					value={model}
					onChange={e => setModel(e.target.value)}
					title="Ollama model name"
					placeholder="Model"
				/>
			</div>

			<div className="ai-chat-messages">
				{messages.length === 0 && (
					<div className="ai-chat-empty">
						<p>Ask me anything about your vault.</p>
						<p className="ai-chat-hint">
							Type <code>/</code> for commands: <code>/write</code>, <code>/find</code>, <code>/summarize</code>
						</p>
					</div>
				)}
				{messages.map((msg, i) => (
					<div key={i} className={`ai-chat-message ai-chat-message--${msg.role}`}>
						<span className="ai-chat-message-role">
							{msg.role === 'user' ? 'You' : 'AI'}
						</span>
						<p className="ai-chat-message-content">{msg.content}</p>
					</div>
				))}
				{loading && (
					<div className="ai-chat-message ai-chat-message--assistant">
						<span className="ai-chat-message-role">AI</span>
						<p className="ai-chat-message-content ai-chat-loading">Thinking…</p>
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<div className="ai-chat-input-area">
				{showPicker && (
					<div className="ai-chat-command-picker">
						{visibleCommands.map((cmd, i) => (
							<button
								key={cmd.id}
								className={`ai-chat-command-item${i === pickerIndex ? ' ai-chat-command-item--active' : ''}`}
								onMouseDown={e => { e.preventDefault(); selectCommand(cmd); }}
								onMouseEnter={() => setPickerIndex(i)}
							>
								<span className="ai-chat-command-label">{cmd.label}</span>
								<span className="ai-chat-command-desc">{cmd.description}</span>
							</button>
						))}
					</div>
				)}
				<div className="ai-chat-input-row">
					<textarea
						ref={textareaRef}
						className="ai-chat-textarea"
						value={input}
						onChange={e => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Message… or type / for commands"
						rows={3}
						disabled={loading}
					/>
					<button
						className="ai-chat-send-btn"
						onClick={() => void handleSend()}
						disabled={loading || !input.trim()}
					>
						Send
					</button>
				</div>
			</div>
		</div>
	);
};
