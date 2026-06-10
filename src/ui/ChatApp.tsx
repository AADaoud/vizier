import React, { useState, useRef, useEffect, useCallback, type SyntheticEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useApp } from '../context';
import type { App } from 'obsidian';
import { AIAgentSettings } from '../settings';
import { MarkdownMessage } from './MarkdownMessage';
import { FindResultsMessage } from './FindResultsMessage';
import {
	SLASH_COMMANDS,
	SlashCommand,
	CommandConfig,
	FindCandidate,
} from '../commands/slashCommands';
import '../commands/registerAll';
import { dispatch, CommandContext } from '../commands/registry';
import { runAgentLoop, type AgentEvent } from '../agent/loop';
import type { MemoryManager } from '../memory/memory_manager';

const HISTORY_KEY = 'vizier-chat-history';
const MAX_HISTORY = 60;

const SPLASH_MESSAGES = [
	'How can I assist?',
	'Ask me anything.',
	'Search your vault.',
	'Summarize a video or article.',
	'Write a note with AI.',
	'Find notes with natural language.',
];

// ── Message types ──────────────────────────────────────────────────────────

export interface ToolChip {
	name: string;
	status: 'running' | 'done' | 'error';
	preview: string;
	duration_ms?: number;
}

interface Message {
	role: 'user' | 'assistant';
	content: string;
	findResults?: { query: string; candidates: FindCandidate[] };
	toolChips?: ToolChip[];
}

interface ChatAppProps {
	settings: AIAgentSettings;
	initialCommand?: string;
	onRegisterInputInjector?: (fn: (text: string) => void) => void;
	memoryManager?: MemoryManager;
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

function loadHistory(app: App): Message[] {
	try {
		const raw = app.loadLocalStorage(HISTORY_KEY) as string | null;
		if (!raw) return [];
		return JSON.parse(raw) as Message[];
	} catch {
		return [];
	}
}

function saveHistory(app: App, messages: Message[]): void {
	try {
		const trimmed = messages.slice(-MAX_HISTORY);
		app.saveLocalStorage(HISTORY_KEY, JSON.stringify(trimmed));
	} catch { /* storage full or unavailable */ }
}

// ── Sub-components ─────────────────────────────────────────────────────────

const BishopIcon = ({ className }: React.SVGProps<SVGSVGElement>) => (
  <svg className={className} viewBox="0 0 32 40" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 37 H24 L22 34 H10 Z" strokeWidth="1.1" />
    <path d="M11 34 L12.5 30 H19.5 L21 34" strokeWidth="1.1" />
    <path d="M13 30 C12 26 11.5 20 13 14 L16 10 L19 14 C20.5 20 20 26 19 30 Z" strokeWidth="1.2" />
    <line x1="16" y1="10" x2="16" y2="15.5" strokeWidth="0.9" />
    <line x1="13.2" y1="26" x2="18.8" y2="26" strokeWidth="0.8" opacity="0.5" />
    <path d="M16 4 L17.4 6.5 L16 9 L14.6 6.5 Z" strokeWidth="1.1" />
    <circle cx="16" cy="2.8" r="0.7" fill="currentColor" stroke="none" />
  </svg>
);

const CopyButton = ({ content }: { content: string }) => {
	const [copied, setCopied] = useState(false);
	const handleCopy = async () => {
		await navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<button className="ai-chat-copy-btn" onClick={() => void handleCopy()} title="Copy message">
			{copied ? 'Copied' : 'Copy'}
		</button>
	);
};

const DotBounce = () => (
	<div className="ai-chat-dot-bounce">
		<span /><span /><span />
	</div>
);

const ToolChipList = ({ chips }: { chips: ToolChip[] }) => (
	<div className="vizier-tool-chips">
		{chips.map((chip, i) => (
			<div key={i} className={`vizier-tool-chip vizier-tool-chip--${chip.status}`}>
				<span className="vizier-tool-chip-icon">
					{chip.status === 'running' ? '⟳' : chip.status === 'done' ? '✓' : '✗'}
				</span>
				<span className="vizier-tool-chip-name">{chip.name}</span>
				{chip.preview && <span className="vizier-tool-chip-preview">{chip.preview}</span>}
				{chip.duration_ms !== undefined && chip.status !== 'running' && (
					<span className="vizier-tool-chip-ms">{chip.duration_ms}ms</span>
				)}
			</div>
		))}
	</div>
);

// ── Main component ─────────────────────────────────────────────────────────

export const ChatApp = ({ settings, initialCommand, onRegisterInputInjector, memoryManager }: ChatAppProps) => {
	const app = useApp();
	const [messages, setMessages] = useState<Message[]>(() => loadHistory(app));
	const [input, setInput] = useState('');
	const [commandLoading, setCommandLoading] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [model, setModel] = useState(settings.defaultModel);
	const [pickerIndex, setPickerIndex] = useState(0);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [ollamaStatus, setOllamaStatus] = useState<'checking' | 'online' | 'offline'>('checking');
	const [splashIdx, setSplashIdx] = useState(0);
	const [splashFade, setSplashFade] = useState(false);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const pendingImageFileRef = useRef<File | null>(null);
	const [pendingImageName, setPendingImageName] = useState<string | null>(null);

	// Track whether current agent run is cancelled (e.g. sidebar closed)
	const cancelledRef = useRef(false);

	const isLoading = commandLoading || streaming;
	const isSplash  = messages.length === 0;

	// ── Ollama model discovery ─────────────────────────────────────────
	const fetchModels = useCallback(async () => {
		setOllamaStatus('checking');
		try {
			// eslint-disable-next-line no-restricted-globals
			const res = await fetch(`${settings.ollamaUrl}/api/tags`);
			if (!res.ok) throw new Error('not ok');
			const data = await res.json() as { models?: { name: string }[] };
			const names = (data.models ?? []).map((m: { name: string }) => m.name);
			setAvailableModels(names);
			setOllamaStatus('online');
			setModel(prev => (names.includes(prev) ? prev : (names[0] ?? prev)));
		} catch {
			setAvailableModels([]);
			setOllamaStatus('offline');
		}
	}, [settings.ollamaUrl]);

	useEffect(() => { void fetchModels(); }, [fetchModels]);
	useEffect(() => { saveHistory(app, messages); }, [messages]);
	useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, commandLoading, streaming]);

	useEffect(() => {
		if (initialCommand) {
			setInput(initialCommand);
			setTimeout(() => textareaRef.current?.focus(), 50);
		}
	}, []); // intentionally only on mount

	useEffect(() => {
		onRegisterInputInjector?.((text: string) => {
			setInput(text);
			setTimeout(() => textareaRef.current?.focus(), 50);
		});
	}, [onRegisterInputInjector]);

	useEffect(() => {
		if (!isSplash) return;
		const id = setInterval(() => {
			setSplashFade(true);
			setTimeout(() => { setSplashIdx(i => (i + 1) % SPLASH_MESSAGES.length); setSplashFade(false); }, 450);
		}, 3500);
		return () => clearInterval(id);
	}, [isSplash]);

	// ── Command picker ─────────────────────────────────────────────────
	const commandFilter = getCommandFilter(input);
	const visibleCommands: SlashCommand[] =
		commandFilter !== null
			? SLASH_COMMANDS.filter(c => c.id.startsWith(commandFilter.toLowerCase()))
			: [];
	const showPicker = visibleCommands.length > 0;
	useEffect(() => { setPickerIndex(0); }, [commandFilter]);

	// ── Message helpers ────────────────────────────────────────────────
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
		app.saveLocalStorage(HISTORY_KEY, null);
	}, []);

	// ── Image paste ────────────────────────────────────────────────────
	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = Array.from(e.clipboardData.items);
		const imageItem = items.find(item => item.type.startsWith('image/'));
		if (!imageItem) return;
		e.preventDefault();
		const file = imageItem.getAsFile();
		if (!file) return;
		pendingImageFileRef.current = file;
		const ext = (file.type.split('/')[1] ?? 'png');
		setPendingImageName(`paste.${ext}`);
		setInput('/handwriting');
	}, []);

	const handleTextareaInput = (e: SyntheticEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		el.setCssStyles({ height: 'auto' });
		el.setCssStyles({ height: `${Math.min(el.scrollHeight, 120)}px` });
	};

	// ── Agent loop integration ─────────────────────────────────────────

	const sendToAgent = useCallback(async (history: Message[], userContent: string) => {
		setStreaming(true);
		cancelledRef.current = false;

		// Add user message + blank assistant placeholder
		setMessages(prev => [
			...prev,
			{ role: 'user', content: userContent },
			{ role: 'assistant', content: '', toolChips: [] },
		]);

		const conversationHistory = history.map(m => ({ role: m.role, content: m.content }));

		// Retrieve memories for this turn
		const memories = memoryManager ? memoryManager.retrieve(userContent, 5) : [];

		// Accumulate the assistant's prose so post-turn extraction sees both sides
		let assistantText = '';

		try {
			await runAgentLoop(
				userContent,
				conversationHistory,
				app,
				settings,
				(event: AgentEvent) => {
					if (cancelledRef.current) return;

					if (event.type === 'token') {
						assistantText += event.content;
						setMessages(prev => {
							const last = prev[prev.length - 1];
							if (last?.role === 'assistant') {
								return [...prev.slice(0, -1), { ...last, content: last.content + event.content }];
							}
							return prev;
						});

					} else if (event.type === 'tool_start') {
						const chip: ToolChip = { name: event.name, status: 'running', preview: '' };
						setMessages(prev => {
							const last = prev[prev.length - 1];
							if (last?.role === 'assistant') {
								const chips = [...(last.toolChips ?? []), chip];
								return [...prev.slice(0, -1), { ...last, toolChips: chips }];
							}
							return prev;
						});

					} else if (event.type === 'tool_result') {
						setMessages(prev => {
							const last = prev[prev.length - 1];
							if (last?.role === 'assistant') {
								const chips = (last.toolChips ?? []).map(c =>
									c.name === event.name && c.status === 'running'
										? { ...c, status: event.ok ? 'done' : 'error', preview: event.preview, duration_ms: event.duration_ms } as ToolChip
										: c
								);
								return [...prev.slice(0, -1), { ...last, toolChips: chips }];
							}
							return prev;
						});

					} else if (event.type === 'error') {
						setMessages(prev => {
							const last = prev[prev.length - 1];
							if (last?.role === 'assistant' && last.content === '') {
								return [...prev.slice(0, -1), { role: 'assistant', content: `Error: ${event.message}` }];
							}
							return [...prev, { role: 'assistant', content: `Error: ${event.message}` }];
						});
					}
				},
				memories
			);

			// Post-turn memory extraction (non-blocking, only if memory feature enabled)
			if (settings.features.memory && memoryManager) {
				const turnMessages = [
					{ role: 'user' as const, content: userContent },
					...(assistantText ? [{ role: 'assistant' as const, content: assistantText.slice(0, 4000) }] : []),
				];
				void memoryManager.extractFromTurn(turnMessages, settings).catch(() => { /* best-effort */ });
			}

		} catch (err) {
			if (!cancelledRef.current) {
				const msg = err instanceof Error ? err.message : String(err);
				setMessages(prev => {
					const last = prev[prev.length - 1];
					if (last?.role === 'assistant' && last.content === '') {
						return [...prev.slice(0, -1), { role: 'assistant', content: `Error: ${msg}` }];
					}
					return [...prev, { role: 'assistant', content: `Error: ${msg}` }];
				});
			}
		} finally {
			setStreaming(false);
		}
	}, [app, settings, memoryManager]);

	// ── Legacy streaming chat (used when agentLoop feature is off) ─────
	const sendToOllama = useCallback(async (history: Message[], userContent: string) => {
		setStreaming(true);
		setMessages(prev => [
			...prev,
			{ role: 'user', content: userContent },
			{ role: 'assistant', content: '' },
		]);

		try {
			// eslint-disable-next-line no-restricted-globals
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

			const reader  = response.body.getReader();
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
					} catch { /* partial JSON */ }
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isConnErr = /failed to fetch|econnrefused|networkerror|network error/i.test(msg);
			const display = isConnErr
				? 'Cannot reach Ollama. Make sure it is running:\n```\nollama serve\n```'
				: `Error: ${msg}`;
			setMessages(prev => {
				const last = prev[prev.length - 1];
				if (last?.role === 'assistant' && last.content === '') {
					return [...prev.slice(0, -1), { role: 'assistant', content: display }];
				}
				return [...prev, { role: 'assistant', content: display }];
			});
		} finally {
			setStreaming(false);
		}
	}, [model, settings.ollamaUrl]);

	// ── Send handler ───────────────────────────────────────────────────
	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || isLoading) return;
		setInput('');
		if (textareaRef.current) textareaRef.current.setCssStyles({ height: 'auto' });

		// Inline memory command: "remember: X" stores directly, no LLM round-trip
		if (memoryManager) {
			const stored = memoryManager.processInlineCommand(text);
			if (stored) {
				addMessage('user', text);
				addMessage('assistant', `Remembered: "${stored.text}"`);
				return;
			}
		}

		const parsed = parseCommand(text);
		const config: CommandConfig = {
			ollamaUrl: settings.ollamaUrl,
			serverUrl: settings.serverUrl,
		};

		// Slash commands route through the existing dispatch system (thin shortcuts)
		if (parsed) {
			addMessage('user', text);

			const ctx: CommandContext = {
				app,
				settings,
				model,
				config,
				addMessage,
				replaceMessage: replaceLastMessage,
				addFindResults,
				pendingImageFile: pendingImageFileRef.current,
				clearPendingImage: () => {
					pendingImageFileRef.current = null;
					setPendingImageName(null);
				},
			};

			const promise = dispatch(parsed.id, parsed.args, ctx);
			if (promise !== null) {
				setCommandLoading(true);
				try { await promise; }
				finally { setCommandLoading(false); }
				return;
			}

			// Unknown slash command — let the agent handle it as free text
			// (removes the hard "Unknown command" error for agent-era usage)
		}

		// Free-form message → agent loop (or legacy streaming if feature is off)
		if (settings.features.agentLoop) {
			await sendToAgent(messages, parsed ? text : text);
		} else {
			await sendToOllama(messages, text);
		}
	}, [input, isLoading, messages, app, model, settings, memoryManager, addMessage, addFindResults, replaceLastMessage, sendToAgent, sendToOllama]);

	const selectCommand = (cmd: SlashCommand) => {
		setInput(cmd.template);
		textareaRef.current?.focus();
	};

	const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (showPicker) {
			if (e.key === 'ArrowDown') { e.preventDefault(); setPickerIndex(i => Math.min(i + 1, visibleCommands.length - 1)); return; }
			if (e.key === 'ArrowUp')   { e.preventDefault(); setPickerIndex(i => Math.max(i - 1, 0)); return; }
			if (e.key === 'Tab' || (e.key === 'Enter' && visibleCommands.length > 0 && !input.includes(' '))) {
				e.preventDefault();
				const cmd = visibleCommands[pickerIndex];
				if (cmd) selectCommand(cmd);
				return;
			}
			if (e.key === 'Escape') { setInput(''); return; }
		}
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); }
	};

	const lastMsgIndex = messages.length - 1;

	// ── Render ─────────────────────────────────────────────────────────
	return (
		<div className={`ai-chat-container${isSplash ? ' ai-chat-container--splash' : ''}`}>

			{/* Header */}
			<div className="ai-chat-header">
				<span className="ai-chat-title">Vizier</span>
				<span className="ai-chat-vault">{app.vault.getName()}</span>
				<select
					className="ai-chat-model-select"
					value={ollamaStatus === 'online' ? model : ''}
					onChange={e => setModel(e.target.value)}
					disabled={ollamaStatus !== 'online'}
					title="Active Ollama model"
				>
					{ollamaStatus === 'checking' && <option value="">Loading…</option>}
					{ollamaStatus === 'offline'  && <option value="">Offline</option>}
					{availableModels.map(m => <option key={m} value={m}>{m}</option>)}
				</select>
				<button className="ai-chat-clear-btn" onClick={clearChat} title="Clear chat history">Clear</button>
			</div>

			{/* Messages */}
			<div className="ai-chat-messages">
				{ollamaStatus === 'offline' && (
					<div className="ai-chat-offline">
						<BishopIcon className="ai-chat-offline-icon" />
						<h2 className="ai-chat-offline-title">Ollama is not running</h2>
						<p className="ai-chat-offline-body">
							Vizier needs a local Ollama instance.<br />
							Start it with <code>ollama serve</code> then retry.
						</p>
						<button className="ai-chat-offline-retry" onClick={() => void fetchModels()}>Retry connection</button>
					</div>
				)}

				{isSplash && ollamaStatus !== 'offline' && (
					<div className="ai-chat-splash">
						<BishopIcon className="ai-chat-splash-icon" />
						<h1 className="ai-chat-splash-title">Vizier</h1>
						<p className={`ai-chat-splash-msg${splashFade ? ' ai-chat-splash-msg--fade' : ''}`}>
							{SPLASH_MESSAGES[splashIdx]}
						</p>
						<p className="ai-chat-splash-hint">
							<code>/write</code><code>/find</code><code>/summarize</code><code>/clip</code>
							<code>/read</code><code>/person</code><code>/event</code><code>/idea</code>
						</p>
					</div>
				)}

				{messages.map((msg, i) => {
					const isLast    = i === lastMsgIndex;
					const showCursor= isLast && streaming && msg.role === 'assistant' && msg.content === '' && !msg.toolChips?.length;
					const showDots  = isLast && commandLoading && msg.role === 'assistant';

					return (
						<div key={i} className={`ai-chat-message ai-chat-message--${msg.role}`}>
							<span className="ai-chat-message-role">{msg.role === 'user' ? 'You' : 'AI'}</span>
							<div className="ai-chat-message-inner">
								{msg.role === 'assistant' ? (
									msg.findResults ? (
										<FindResultsMessage query={msg.findResults.query} candidates={msg.findResults.candidates} />
									) : (
										<div className="ai-chat-markdown-body-wrap">
											{msg.toolChips && msg.toolChips.length > 0 && (
												<ToolChipList chips={msg.toolChips} />
											)}
											{showCursor ? (
												<div className="ai-chat-markdown-body">
													<span className="ai-chat-streaming-cursor" />
												</div>
											) : (
												<MarkdownMessage content={msg.content} />
											)}
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

			{/* Input area */}
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
				{pendingImageName && (
					<div className="vizier-image-attachment">
						<span className="vizier-image-attachment-label">{pendingImageName}</span>
						<button className="vizier-image-attachment-remove" onClick={() => {
							pendingImageFileRef.current = null;
							setPendingImageName(null);
							setInput('');
						}}>✕</button>
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
						onPaste={handlePaste}
						placeholder="Message… or type / for commands"
						rows={1}
						disabled={isLoading || ollamaStatus === 'offline'}
					/>
					<button
						className="ai-chat-send-btn"
						onClick={() => void handleSend()}
						disabled={isLoading || !input.trim() || ollamaStatus === 'offline'}
						title="Send"
					>
						➤
					</button>
				</div>
			</div>
		</div>
	);
};
