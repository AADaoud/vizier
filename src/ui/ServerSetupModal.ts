import { App, Modal, Notice, FileSystemAdapter, requestUrl } from 'obsidian';
import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _proc = (globalThis as any).process as { env: Record<string, string>; platform?: string } | undefined;
const IS_WINDOWS = _proc?.platform === 'win32';
const PATH_SEP = IS_WINDOWS ? ';' : ':';

const EXPANDED_PATH = IS_WINDOWS
	? [
		_proc?.env?.PATH ?? '',
		_proc?.env?.USERPROFILE ? `${_proc.env.USERPROFILE}\\AppData\\Local\\Programs\\Python\\Python312` : '',
		_proc?.env?.USERPROFILE ? `${_proc.env.USERPROFILE}\\AppData\\Local\\Programs\\Python\\Python311` : '',
		_proc?.env?.USERPROFILE ? `${_proc.env.USERPROFILE}\\AppData\\Local\\Programs\\Python\\Python310` : '',
		'C:\\Python312',
		'C:\\Python311',
		'C:\\Python310',
	].filter(Boolean).join(PATH_SEP)
	: [
		_proc?.env?.PATH ?? '',
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		'/opt/homebrew/bin',
		'/opt/homebrew/opt/python@3.12/bin',
		'/opt/homebrew/opt/python@3.11/bin',
	].filter(Boolean).join(PATH_SEP);

/** Returns the venv python executable path, platform-aware. */
function venvPython(pluginDir: string): string {
	return IS_WINDOWS
		? path.join(pluginDir, '.venv', 'Scripts', 'python.exe')
		: path.join(pluginDir, '.venv', 'bin', 'python3');
}

/** Returns the venv pip executable path, platform-aware. */
function venvPip(pluginDir: string): string {
	return IS_WINDOWS
		? path.join(pluginDir, '.venv', 'Scripts', 'pip.exe')
		: path.join(pluginDir, '.venv', 'bin', 'pip3');
}

function spawnProc(cmd: string, args: string[], opts?: SpawnOptions): ChildProcess {
	const baseOpts = opts ?? {};
	const env = { ...(_proc?.env ?? {}), ...(baseOpts.env as Record<string, string> | undefined), PATH: EXPANDED_PATH };
	return spawn(cmd, args, { ...baseOpts, env });
}

function runCmd(cmd: string, args: string[], cwd: string, log: (m: string) => void): Promise<boolean> {
	return new Promise((resolve) => {
		const proc = spawnProc(cmd, args, { cwd });
		proc.stdout?.on('data', (d: { toString(): string }) => log(d.toString().trimEnd()));
		proc.stderr?.on('data', (d: { toString(): string }) => log(d.toString().trimEnd()));
		proc.on('close', (code: number) => {
			if (code !== 0) log(`Command failed (exit ${String(code)}).`);
			resolve(code === 0);
		});
		proc.on('error', (err: Error) => {
			log(`Error: ${err.message}`);
			resolve(false);
		});
	});
}

/**
 * Manages the transcript server child process lifecycle.
 * Attach to the plugin so it can be stopped on unload.
 */
export class TranscriptServerManager {
	private process: ChildProcess | null = null;
	private pluginDir: string;

	constructor(app: App, manifestDir: string) {
		const adapter = app.vault.adapter as FileSystemAdapter;
		this.pluginDir = adapter.getFullPath(manifestDir);
	}

	get isRunning(): boolean {
		return this.process !== null && !this.process.killed;
	}

	/** Check if the server is reachable at the given URL. */
	async isServerReachable(serverUrl: string): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: `${serverUrl}/health`,
				throw: false,
			});
			// Any response (even 500) means the server is up
			return res.status > 0;
		} catch {
			return false;
		}
	}

	/** Start the server using a venv inside the plugin directory. */
	startServer(): Promise<void> {
		return new Promise((resolve, reject) => {
			const script = path.join(this.pluginDir, 'vizier_server.py');
			this.process = spawnProc(venvPython(this.pluginDir), [script], {
				cwd: this.pluginDir,
			});

			this.process.stdout?.on('data', (data: { toString(): string }) => {
				const line = data.toString();
				if (line.includes('running on')) resolve();
			});

			this.process.stderr?.on('data', (data: { toString(): string }) => {
				logger.error('vizier_server stderr:', data.toString());
			});

			this.process.on('error', (err) => {
				this.process = null;
				reject(new Error(`Failed to start server: ${err.message}. Run setup first.`));
			});

			this.process.on('exit', (code) => {
				this.process = null;
				if (code !== 0 && code !== null) {
					reject(new Error(`Server exited with code ${code}. Run setup again.`));
				}
			});

			// Resolve after 2 s even if stdout line wasn't seen (older Python versions)
			setTimeout(resolve, 2000);
		});
	}

	stopServer(): void {
		if (this.process && !this.process.killed) {
			if (IS_WINDOWS && this.process.pid !== undefined) {
				// SIGTERM is not reliable on Windows — use taskkill to ensure the tree is killed
				spawn('taskkill', ['/pid', String(this.process.pid), '/f', '/t']);
			} else {
				this.process.kill('SIGTERM');
			}
			this.process = null;
		}
	}
}

/**
 * Modal shown when the server isn't running.
 * Auto-detects whether setup is needed: if the venv already exists,
 * it just starts; otherwise it runs setup first.
 */
export class ServerSetupModal extends Modal {
	private manager: TranscriptServerManager;
	private serverUrl: string;
	private onStarted: () => void;

	constructor(app: App, manager: TranscriptServerManager, serverUrl: string, onStarted: () => void) {
		super(app);
		this.manager = manager;
		this.serverUrl = serverUrl;
		this.onStarted = onStarted;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Vizier server' });
		contentEl.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: 'A small local Python server is required for YouTube transcripts, Wikipedia lookups (Human Network), and handwriting OCR. Click "Start" to set up and launch it automatically.',
		});

		const pre = contentEl.createEl('pre', { cls: 'vizier-setup-log' });
		pre.textContent = 'Ready. Click Start to begin.\n';

		const log = (msg: string) => {
			pre.textContent += msg + '\n';
			pre.scrollTop = pre.scrollHeight;
		};

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const startBtn = btnRow.createEl('button', { text: 'Start', cls: 'mod-cta' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

		cancelBtn.onclick = () => this.close();

		startBtn.onclick = async () => {
			startBtn.disabled = true;
			cancelBtn.disabled = true;

			// If already running in this session, skip entirely
			if (this.manager.isRunning) {
				log('Server is already running.');
				new Notice('Vizier server is running.');
				this.onStarted();
				this.close();
				return;
			}

			const pluginDir = (this.manager as unknown as { pluginDir: string }).pluginDir;
			const pip = venvPip(pluginDir);

			// Auto-detect whether initial setup is needed
			const alreadySetup = await this.isSetupDone(pluginDir);
			if (!alreadySetup) {
				log('Detecting Python…');
				const python = await this.findPython(log);
				if (!python) {
					log('❌ Python 3 not found. Please install Python 3.8+ and try again.');
					startBtn.disabled = false;
					cancelBtn.disabled = false;
					return;
				}

				log(`Using: ${python}`);
				log('Creating virtual environment (.venv)…');
				const venvOk = await runCmd(python, ['-m', 'venv', '.venv'], pluginDir, log);
				if (!venvOk) {
					log('❌ Failed to create virtual environment.');
					startBtn.disabled = false;
					cancelBtn.disabled = false;
					return;
				}

				log('Installing core dependencies (youtube-transcript-api, wikipedia-api)…');
				const pipOk = await runCmd(pip, ['install', 'youtube-transcript-api', 'wikipedia-api'], pluginDir, log);
				if (!pipOk) {
					log('❌ Dependency installation failed. Check the log above.');
					startBtn.disabled = false;
					cancelBtn.disabled = false;
					return;
				}
			} else {
				// Venv exists — ensure wikipedia-api is present (may be missing on older installs)
				log('Checking for wikipedia-api…');
				const wikiOk = await runCmd(pip, ['install', 'wikipedia-api'], pluginDir, log);
				if (!wikiOk) {
					log('⚠ Could not install wikipedia-api — Wikipedia features will be unavailable.');
				}
			}

			log('Checking if server is already running…');
			const alreadyRunning = await this.manager.isServerReachable(this.serverUrl);
			if (alreadyRunning) {
				log('Server is already running.');
				new Notice('Vizier server is running.');
				this.onStarted();
				this.close();
				void this.checkModelsAndPrompt();
				return;
			}

			log('Starting server…');
			try {
				await this.manager.startServer();
				log('Server started.');
				new Notice('Vizier server started.');
				this.onStarted();
				this.close();
				void this.checkModelsAndPrompt();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`❌ ${msg}`);
				startBtn.disabled = false;
				cancelBtn.disabled = false;
			}
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async checkModelsAndPrompt(): Promise<void> {
		const pluginDir = (this.manager as unknown as { pluginDir: string }).pluginDir;
		try {
			const res = await requestUrl({ url: `${this.serverUrl}/models/status`, throw: false });
			if (res.status === 200) {
				const data = res.json as { cached?: boolean; installed?: boolean };
				if (!data.installed || !data.cached) {
					new ModelDownloadModal(this.app, this.serverUrl, pluginDir).open();
				}
			}
		} catch { /* ignore */ }
	}

	private isSetupDone(pluginDir: string): Promise<boolean> {
		return new Promise(resolve => {
			const python3 = venvPython(pluginDir);
			const proc = spawnProc(python3, ['--version']);
			proc.on('close', (code: number) => resolve(code === 0));
			proc.on('error', () => resolve(false));
		});
	}

	private findPython(log: (m: string) => void): Promise<string | null> {
		return new Promise((resolve) => {
			// On Windows `python` is the standard launcher; on Unix prefer `python3`
			const candidates: string[] = IS_WINDOWS ? ['python', 'python3'] : ['python3', 'python'];
			let idx = 0;
			const tryNext = () => {
				if (idx >= candidates.length) { resolve(null); return; }
				const cmd: string = candidates[idx++] as string;
				const proc = spawnProc(cmd, ['--version']);
				proc.on('close', (code: number) => {
					if (code === 0) { resolve(cmd); }
					else { tryNext(); }
				});
				proc.on('error', () => tryNext());
			};
			log('Checking python3 / python…');
			tryNext();
		});
	}

}

/**
 * Modal shown after server start when OCR models haven't been downloaded yet.
 * Offers to download ~250 MB of EasyOCR model files in the background,
 * with a spinner and polling until the download completes.
 */
export class ModelDownloadModal extends Modal {
	private serverUrl: string;
	private pluginDir: string;
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private pollCount = 0;
	private readonly MAX_POLLS = 120; // 10 minutes at 5 s intervals

	constructor(app: App, serverUrl: string, pluginDir: string) {
		super(app);
		this.serverUrl = serverUrl;
		this.pluginDir = pluginDir;
	}

	onOpen(): void {
		const { contentEl } = this;
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		contentEl.createEl('h2', { text: 'OCR setup' });
		contentEl.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: 'Handwriting OCR requires ML libraries (~1.5 GB including PyTorch) and model files. These are installed once and cached locally.',
		});

		const pre = contentEl.createEl('pre', { cls: 'vizier-setup-log' });
		pre.addClass('vizier-hidden');
		const log = (msg: string) => {
			pre.removeClass('vizier-hidden');
			pre.textContent += msg + '\n';
			pre.scrollTop = pre.scrollHeight;
		};

		const spinner = contentEl.createDiv({ cls: 'vizier-spinner' });
		spinner.addClass('vizier-hidden');

		const statusEl = contentEl.createEl('p', { cls: 'vizier-model-status' });
		statusEl.addClass('vizier-hidden');

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const downloadBtn = btnRow.createEl('button', { text: 'Download now', cls: 'mod-cta' });
		const skipBtn = btnRow.createEl('button', { text: 'Not now' });

		skipBtn.onclick = () => this.close();

		downloadBtn.onclick = async () => {
			downloadBtn.disabled = true;
			skipBtn.disabled = true;
			spinner.removeClass('vizier-hidden');
			statusEl.removeClass('vizier-hidden');
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			statusEl.textContent = 'Installing OCR libraries… this may take several minutes.';

			// Install easyocr (heavy: PyTorch etc.)
			const pip = venvPip(this.pluginDir);
			const pipOk = await runCmd(pip, ['install', 'easyocr'], this.pluginDir, log);
			if (!pipOk) {
				spinner.addClass('vizier-hidden');
				statusEl.textContent = 'Installation failed. Check the log above.';
				return;
			}

			// eslint-disable-next-line obsidianmd/ui/sentence-case
			statusEl.textContent = 'Downloading OCR models… this may take several minutes.';

			// Trigger model download (non-blocking — server returns 202 immediately)
			try {
				await requestUrl({ url: `${this.serverUrl}/models/download`, method: 'POST', throw: false });
			} catch { /* ignore */ }

			// Poll for completion every 5 s
			this.pollCount = 0;
			this.pollInterval = setInterval(
				() => void this.pollStatus(spinner, statusEl),
				5000
			);
		};
	}

	private async pollStatus(spinner: HTMLElement, statusEl: HTMLElement): Promise<void> {
		this.pollCount++;
		try {
			const res = await requestUrl({ url: `${this.serverUrl}/models/status`, throw: false });
			if (res.status === 200) {
				const data = res.json as { cached?: boolean };
				if (data.cached) {
					this.stopPolling();
					spinner.addClass('vizier-hidden');
					statusEl.textContent = 'Models downloaded and ready.';
					setTimeout(() => this.close(), 1500);
					return;
				}
			}
		} catch { /* ignore */ }

		if (this.pollCount >= this.MAX_POLLS) {
			this.stopPolling();
			spinner.addClass('vizier-hidden');
			statusEl.textContent = 'Download timed out. Models will download automatically on first use.';
		}
	}

	private stopPolling(): void {
		if (this.pollInterval !== null) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	onClose(): void {
		this.stopPolling();
		this.contentEl.empty();
	}
}
