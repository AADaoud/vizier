import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context';
import { AIAgentSettings } from '../settings';
import { MarkdownMessage } from './MarkdownMessage';
import { FindResultsMessage } from './FindResultsMessage';
import {
	SLASH_COMMANDS,
	SlashCommand,
	CommandConfig,
	FindCandidate,
	executeWrite,
	executeFind,
	executeSummarize,
	executeClip,
	executeRead,
} from '../commands/slashCommands';

const HISTORY_KEY = 'vizier-chat-history';
const MAX_HISTORY = 60;

interface Message {
	role: 'user' | 'assistant';
	content: string;
	findResults?: { query: string; candidates: FindCandidate[] };
}

interface ChatAppProps {
	settings: AIAgentSettings;
	initialCommand?: string;
	onRegisterInputInjector?: (fn: (text: string) => void) => void;
}

function getCommandFilter(input: string): string | null {
	if (!input.startsWith('/')) return null;
	const space = input.indexOf(' ');
	return space === -1 ? input.slice(1) : null;
}

function parseCommand(input: string): { id: string; args: string } | null {
	if (!input.startsWith('/')) return null;
	const space = input.indexOf(' ');
	if (space === -1) return { id: input.slice(1), args: '' };
	return { id: input.slice(1, space), args: input.slice(space + 1) };
}

function loadHistory(): Message[] {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		if (!raw) return [];
		return JSON.parse(raw) as Message[];
	} catch {
		return [];
	}
}

function saveHistory(messages: Message[]): void {
	try {
		const trimmed = messages.slice(-MAX_HISTORY);
		localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
	} catch { /* storage full or unavailable */ }
}

const CopyButton = ({ content }: { content: string }) => {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<button
			className="ai-chat-copy-btn"
			onClick={() => void handleCopy()}
			title="Copy message"
		>
			{copied ? 'Copied' : 'Copy'}
		</button>
	);
};

const DotBounce = () => (
	<div className="ai-chat-dot-bounce">
		<span /><span /><span />
	</div>
);

export const ChatApp = ({ settings, initialCommand, onRegisterInputInjector }: ChatAppProps) => {
	const app = useApp();
	const [messages, setMessages] = useState<Message[]>(() => loadHistory());
	const [input, setInput] = useState('');
	const [commandLoading, setCommandLoading] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [model, setModel] = useState(settings.defaultModel);
	const [pickerIndex, setPickerIndex] = useState(0);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const isLoading = commandLoading || streaming;

	// Persist history whenever messages change
	useEffect(() => {
		saveHistory(messages);
	}, [messages]);

	// Scroll to bottom on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, commandLoading, streaming]);

	// Pre-fill input from initialCommand (set when view opens with a pending command)
	useEffect(() => {
		if (initialCommand) {
			setInput(initialCommand);
			setTimeout(() => textareaRef.current?.focus(), 50);
		}
	}, []); // intentionally run only on mount

	// Register the injector so ChatView can push commands into an already-open chat
	useEffect(() => {
		onRegisterInputInjector?.((text: string) => {
			setInput(text);
			setTimeout(() => textareaRef.current?.focus(), 50);
		});
	}, [onRegisterInputInjector]);

	const commandFilter = getCommandFilter(input);
	const visibleCommands: SlashCommand[] =
		commandFilter !== null
			? SLASH_COMMANDS.filter(c => c.id.startsWith(commandFilter.toLowerCase()))
			: [];
	const showPicker = visibleCommands.length > 0;

	useEffect(() => {
		setPickerIndex(0);
	}, [commandFilter]);

	const addMessage = useCallback((role: 'user' | 'assistant', content: string) => {
		setMessages(prev => [...prev, { role, content }]);
	}, []);

	const replaceLastMessage = useCallback((role: 'user' | 'assistant', content: string) => {
		setMessages(prev => {
			const last = prev[prev.length - 1];
			if (last?.role === role) return [...prev.slice(0, -1), { role, content }];
			return [...prev, { role, content }];
		});
	}, []);

	const addFindResults = useCallback((query: string, candidates: FindCandidate[]) => {
		setMessages(prev => {
			const last = prev[prev.length - 1];
			if (last?.role === 'assistant' && !last.findResults) {
				return [...prev.slice(0, -1), { role: 'assistant', content: '', findResults: { query, candidates } }];
			}
			return [...prev, { role: 'assistant', content: '', findResults: { query, candidates } }];
		});
	}, []);

	const clearChat = useCallback(() => {
		setMessages([]);
		localStorage.removeItem(HISTORY_KEY);
	}, []);

	// Auto-resize textarea
	const handleTextareaInput = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	};

	// Streaming chat — only for freeform messages
	const sendToOllama = useCallback(async (history: Message[], userContent: string) => {
		setStreaming(true);
		setMessages(prev => [
			...prev,
			{ role: 'user', content: userContent },
			{ role: 'assistant', content: '' },
		]);

		try {
			const response = await fetch(`${settings.ollamaUrl}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model,
					messages: [
						...history.map(m => ({ role: m.role, content: m.content })),
						{ role: 'user', content: userContent },
					],
					stream: true,
				}),
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			if (!response.body) throw new Error('No response body');

			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = decoder.decode(value, { stream: true });
				for (const line of chunk.split('\n')) {
					if (!line.trim()) continue;
					try {
						const parsed = JSON.parse(line) as { message?: { content?: string } };
						const token = parsed.message?.content ?? '';
						if (token) {
							setMessages(prev => {
								const last = prev[prev.length - 1];
								if (last?.role === 'assistant') {
									return [...prev.slice(0, -1), { role: 'assistant', content: last.content + token }];
								}
								return prev;
							});
						}
					} catch { /* partial JSON line */ }
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setMessages(prev => {
				const last = prev[prev.length - 1];
				if (last?.role === 'assistant' && last.content === '') {
					return [...prev.slice(0, -1), { role: 'assistant', content: `Error: ${msg}` }];
				}
				return [...prev, { role: 'assistant', content: `Error: ${msg}` }];
			});
		} finally {
			setStreaming(false);
		}
	}, [model, settings.ollamaUrl]);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || isLoading) return;
		setInput('');
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto';
		}

		const parsed = parseCommand(text);
		const config: CommandConfig = {
			ollamaUrl: settings.ollamaUrl,
			transcriptServerUrl: settings.transcriptServerUrl,
		};

		if (parsed) {
			addMessage('user', text);

			if (parsed.id === 'write') {
				setCommandLoading(true);
				try {
					await executeWrite(parsed.args, app, addMessage, model, config, settings.aiNotesFolder);
				} finally {
					setCommandLoading(false);
				}
				return;
			}

			if (parsed.id === 'find') {
				setCommandLoading(true);
				try {
					await executeFind(parsed.args, app, addMessage, addFindResults, model, config);
				} finally {
					setCommandLoading(false);
				}
				return;
			}

			if (parsed.id === 'summarize') {
				setCommandLoading(true);
				try {
					await executeSummarize(parsed.args, addMessage, replaceLastMessage, model, config);
				} finally {
					setCommandLoading(false);
				}
				return;
			}

			if (parsed.id === 'clip') {
				setCommandLoading(true);
				try {
					await executeClip(parsed.args, app, addMessage, replaceLastMessage, model, config, settings.clipsFolder);
				} finally {
					setCommandLoading(false);
				}
				return;
			}

			if (parsed.id === 'read') {
				setCommandLoading(true);
				try {
					await executeRead(parsed.args, app, addMessage, model, config);
				} finally {
					setCommandLoading(false);
				}
				return;
			}

			addMessage('assistant', `Unknown command \`/${parsed.id}\`. Available: /write, /find, /summarize, /clip, /read`);
			return;
		}

		// Regular streaming chat
		await sendToOllama(messages, text);
	}, [input, isLoading, messages, app, model, settings, addMessage, addFindResults, replaceLastMessage, sendToOllama]);

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

	const lastMsgIndex = messages.length - 1;
	// No separate cursor/loading blocks — both are rendered inline inside the last bubble.

	return (
		<div className="ai-chat-container">
			<div className="ai-chat-header">
				<span className="ai-chat-title">Vizier</span>
				<span className="ai-chat-vault">{app.vault.getName()}</span>
				<input
					className="ai-chat-model-input"
					value={model}
					onChange={e => setModel(e.target.value)}
					title="Ollama model name"
					placeholder="Model"
				/>
				<button
					className="ai-chat-clear-btn"
					onClick={clearChat}
					title="Clear chat history"
				>
					Clear
				</button>
			</div>

			<div className="ai-chat-messages">
				{messages.length === 0 && (
					<div className="ai-chat-empty">
						<p>Ask me anything, or use a command.</p>
						<p className="ai-chat-hint">
							<code>/write</code> <code>/find</code> <code>/summarize</code> <code>/clip</code> <code>/clip long</code> <code>/read</code>
						</p>
					</div>
				)}
				{messages.map((msg, i) => {
					const isLast = i === lastMsgIndex;
					// Show streaming cursor inside this bubble when streaming hasn't produced text yet
					const showCursor = isLast && streaming && msg.role === 'assistant' && msg.content === '';
					// Show dots after status text when a slash command is running
					const showDots = isLast && commandLoading && msg.role === 'assistant';

					return (
						<div key={i} className={`ai-chat-message ai-chat-message--${msg.role}`}>
							<span className="ai-chat-message-role">
								{msg.role === 'user' ? 'You' : 'AI'}
							</span>
							<div className="ai-chat-message-inner">
								{msg.role === 'assistant' ? (
									msg.findResults ? (
										<FindResultsMessage query={msg.findResults.query} candidates={msg.findResults.candidates} />
									) : showCursor ? (
										<div className="ai-chat-markdown-body">
											<span className="ai-chat-streaming-cursor" />
										</div>
									) : (
										<div className="ai-chat-markdown-body-wrap">
											<MarkdownMessage content={msg.content} />
											{showDots && <DotBounce />}
										</div>
									)
								) : (
									<p className="ai-chat-message-content">{msg.content}</p>
								)}
								{msg.role === 'assistant' && msg.content && !msg.findResults && !showDots && (
									<CopyButton content={msg.content} />
								)}
							</div>
						</div>
					);
				})}
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
						onInput={handleTextareaInput}
						onKeyDown={handleKeyDown}
						placeholder="Message… or type / for commands"
						rows={1}
						disabled={isLoading}
					/>
					<button
						className="ai-chat-send-btn"
						onClick={() => void handleSend()}
						disabled={isLoading || !input.trim()}
						title="Send"
					>
						➤
					</button>
				</div>
			</div>
		</div>
	);
};
