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

const BishopIcon = ({ className }: React.SVGProps<SVGSVGElement>) => (
  <svg className={className} viewBox="0 0 32 40" fill="none"
    stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    {/* base */}
    <path d="M8 37 H24 L22 34 H10 Z" strokeWidth="1.1" />
    {/* pedestal */}
    <path d="M11 34 L12.5 30 H19.5 L21 34" strokeWidth="1.1" />
    {/* body — clean tapered trapezoid with slight curve */}
    <path d="M13 30 C12 26 11.5 20 13 14 L16 10 L19 14 C20.5 20 20 26 19 30 Z" strokeWidth="1.2" />
    {/* mitre slit */}
    <line x1="16" y1="10" x2="16" y2="15.5" strokeWidth="0.9" />
    {/* collar band */}
    <line x1="13.2" y1="26" x2="18.8" y2="26" strokeWidth="0.8" opacity="0.5" />
    {/* finial — small diamond */}
    <path d="M16 4 L17.4 6.5 L16 9 L14.6 6.5 Z" strokeWidth="1.1" />
    {/* pip */}
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

	const isLoading = commandLoading || streaming;
	const isSplash = messages.length === 0;

	// ── Ollama model discovery ─────────────────────────────────────
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
			// Keep current model if it's valid, otherwise fall back to first available
			setModel(prev => (names.includes(prev) ? prev : (names[0] ?? prev)));
		} catch {
			setAvailableModels([]);
			setOllamaStatus('offline');
		}
	}, [settings.ollamaUrl]);

	useEffect(() => {
		void fetchModels();
	}, [fetchModels]);

	// ── Persist history ────────────────────────────────────────────
	useEffect(() => {
		saveHistory(app, messages);
	}, [messages]);

	// ── Scroll to bottom on new messages ──────────────────────────
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages, commandLoading, streaming]);

	// ── Pre-fill from initialCommand ──────────────────────────────
	useEffect(() => {
		if (initialCommand) {
			setInput(initialCommand);
			setTimeout(() => textareaRef.current?.focus(), 50);
		}
	}, []); // intentionally run only on mount

	// ── Register injector ─────────────────────────────────────────
	useEffect(() => {
		onRegisterInputInjector?.((text: string) => {
			setInput(text);
			setTimeout(() => textareaRef.current?.focus(), 50);
		});
	}, [onRegisterInputInjector]);

	// ── Splash message cycling ─────────────────────────────────────
	useEffect(() => {
		if (!isSplash) return;
		const id = setInterval(() => {
			setSplashFade(true);
			setTimeout(() => {
				setSplashIdx(i => (i + 1) % SPLASH_MESSAGES.length);
				setSplashFade(false);
			}, 450);
		}, 3500);
		return () => clearInterval(id);
	}, [isSplash]);

	// ── Command picker ─────────────────────────────────────────────
	const commandFilter = getCommandFilter(input);
	const visibleCommands: SlashCommand[] =
		commandFilter !== null
			? SLASH_COMMANDS.filter(c => c.id.startsWith(commandFilter.toLowerCase()))
			: [];
	const showPicker = visibleCommands.length > 0;

	useEffect(() => {
		setPickerIndex(0);
	}, [commandFilter]);

	// ── Message helpers ────────────────────────────────────────────
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

	// ── Image paste handler ────────────────────────────────────────
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

	// ── Auto-resize textarea ───────────────────────────────────────
	const handleTextareaInput = (e: SyntheticEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		el.setCssStyles({ height: 'auto' });
		el.setCssStyles({ height: `${Math.min(el.scrollHeight, 120)}px` });
	};

	// ── Streaming chat ─────────────────────────────────────────────
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

	// ── Send handler ───────────────────────────────────────────────
	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || isLoading) return;
		setInput('');
		if (textareaRef.current) {
			textareaRef.current.setCssStyles({ height: 'auto' });
		}

		const parsed = parseCommand(text);
		const config: CommandConfig = {
			ollamaUrl: settings.ollamaUrl,
			serverUrl: settings.serverUrl,
		};

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

			addMessage('assistant', `Unknown command \`/${parsed.id}\`. Available: /write, /edit, /find, /summarize, /clip, /clip long, /clip learn, /read, /handwriting, /person, /event, /idea, /link`);
			return;
		}

		await sendToOllama(messages, text);
	}, [input, isLoading, messages, app, model, settings, addMessage, addFindResults, replaceLastMessage, sendToOllama]);

	// ── Command picker selection ───────────────────────────────────
	const selectCommand = (cmd: SlashCommand) => {
		setInput(cmd.template);
		textareaRef.current?.focus();
	};

	const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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

	// ── Render ─────────────────────────────────────────────────────
	return (
		<div className={`ai-chat-container${isSplash ? ' ai-chat-container--splash' : ''}`}>

			{/* Header */}
			<div className="ai-chat-header">
				<span className="ai-chat-title">Vizier</span>
				<span className="ai-chat-vault">{app.vault.getName()}</span>

				{/* Model dropdown */}
				<select
					className="ai-chat-model-select"
					value={ollamaStatus === 'online' ? model : ''}
					onChange={e => setModel(e.target.value)}
					disabled={ollamaStatus !== 'online'}
					title="Active Ollama model"
				>
					{ollamaStatus === 'checking' && <option value="">Loading…</option>}
					{ollamaStatus === 'offline' && <option value="">Offline</option>}
					{availableModels.map(m => (
						<option key={m} value={m}>{m}</option>
					))}
				</select>

				<button
					className="ai-chat-clear-btn"
					onClick={clearChat}
					title="Clear chat history"
				>
					Clear
				</button>
			</div>

			{/* Messages / splash / offline */}
			<div className="ai-chat-messages">

				{/* Offline state */}
				{ollamaStatus === 'offline' && (
					<div className="ai-chat-offline">
						<BishopIcon className="ai-chat-offline-icon" />
						<h2 className="ai-chat-offline-title">Ollama is not running</h2>
						<p className="ai-chat-offline-body">
							Vizier needs a local Ollama instance.<br />
							Start it with <code>ollama serve</code> then retry.
						</p>
						<button
							className="ai-chat-offline-retry"
							onClick={() => void fetchModels()}
						>
							Retry connection
						</button>
					</div>
				)}

				{/* Splash / welcome screen */}
				{isSplash && ollamaStatus !== 'offline' && (
					<div className="ai-chat-splash">
						<BishopIcon className="ai-chat-splash-icon" />
						<h1 className="ai-chat-splash-title">Vizier</h1>
						<p className={`ai-chat-splash-msg${splashFade ? ' ai-chat-splash-msg--fade' : ''}`}>
							{SPLASH_MESSAGES[splashIdx]}
						</p>
						<p className="ai-chat-splash-hint">
							<code>/write</code>
							<code>/find</code>
							<code>/summarize</code>
							<code>/clip</code>
							<code>/read</code>
							<code>/person</code>
							<code>/event</code>
							<code>/idea</code>
						</p>
					</div>
				)}

				{/* Chat messages */}
				{messages.map((msg, i) => {
					const isLast = i === lastMsgIndex;
					const showCursor = isLast && streaming && msg.role === 'assistant' && msg.content === '';
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
