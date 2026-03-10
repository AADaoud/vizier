import { App, Modal, Notice, FileSystemAdapter, requestUrl } from 'obsidian';
import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';
import * as path from 'path';

function spawnProc(cmd: string, args: string[], opts?: SpawnOptions): ChildProcess {
	return spawn(cmd, args, opts ?? {});
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
	async isServerReachable(transcriptServerUrl: string): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: `${transcriptServerUrl}/transcript?video_id=test`,
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
			const script = path.join(this.pluginDir, 'transcript_server.py');
			const venvPython = path.join(this.pluginDir, '.venv', 'bin', 'python3');
			this.process = spawnProc(venvPython, [script], {
				cwd: this.pluginDir,
			});

			this.process.stdout?.on('data', (data: { toString(): string }) => {
				const line = data.toString();
				if (line.includes('running on')) resolve();
			});

			this.process.stderr?.on('data', (data: { toString(): string }) => {
				console.error('[Vizier] transcript_server stderr:', data.toString());
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
			this.process.kill('SIGTERM');
			this.process = null;
		}
	}
}

/**
 * Modal shown when the transcript server isn't running.
 * Offers one-click setup (create venv, install deps) and start.
 */
export class ServerSetupModal extends Modal {
	private manager: TranscriptServerManager;
	private onStarted: () => void;

	constructor(app: App, manager: TranscriptServerManager, onStarted: () => void) {
		super(app);
		this.manager = manager;
		this.onStarted = onStarted;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'YouTube transcript server' });
		contentEl.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			text: 'A small local Python server is required to fetch YouTube transcripts. Click "Setup & start" to automatically create a virtual environment, install dependencies, and launch the server.',
		});

		const pre = contentEl.createEl('pre', { cls: 'vizier-setup-log' });
		pre.textContent = '';

		const log = (msg: string) => {
			pre.textContent += msg + '\n';
			pre.scrollTop = pre.scrollHeight;
		};

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });

		const setupBtn = btnRow.createEl('button', { text: 'Setup & start', cls: 'mod-cta' });
		const startBtn = btnRow.createEl('button', { text: 'Start only' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });

		cancelBtn.onclick = () => this.close();

		startBtn.onclick = async () => {
			setupBtn.disabled = true;
			startBtn.disabled = true;
			log('Starting server…');
			try {
				await this.manager.startServer();
				log('Server started successfully.');
				new Notice('Transcript server started.');
				this.onStarted();
				this.close();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`Error: ${msg}`);
				setupBtn.disabled = false;
				startBtn.disabled = false;
			}
		};

		setupBtn.onclick = async () => {
			setupBtn.disabled = true;
			startBtn.disabled = true;
			log('Detecting Python…');

			const pluginDir = (this.manager as unknown as { pluginDir: string }).pluginDir;

			// Step 1: find python3
			const python = await this.findPython(log);
			if (!python) {
				log('Python 3 not found. Please install Python 3.8+ and try again.');
				setupBtn.disabled = false;
				startBtn.disabled = false;
				return;
			}

			// Step 2: create venv
			log(`Using: ${python}`);
			log('Creating virtual environment (.venv)…');
			const venvOk = await this.runCmd(python, ['-m', 'venv', '.venv'], pluginDir, log);
			if (!venvOk) {
				setupBtn.disabled = false;
				startBtn.disabled = false;
				return;
			}

			// Step 3: install dependency
			const pip = path.join(pluginDir, '.venv', 'bin', 'pip3');
			log('Installing youtube-transcript-api…');
			const pipOk = await this.runCmd(pip, ['install', 'youtube-transcript-api'], pluginDir, log);
			if (!pipOk) {
				setupBtn.disabled = false;
				startBtn.disabled = false;
				return;
			}

			// Step 4: start
			log('Starting server…');
			try {
				await this.manager.startServer();
				log('Done! Server is running.');
				new Notice('Transcript server set up and started.');
				this.onStarted();
				this.close();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log(`Error: ${msg}`);
				setupBtn.disabled = false;
				startBtn.disabled = false;
			}
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private findPython(log: (m: string) => void): Promise<string | null> {
		return new Promise((resolve) => {
			const candidates: string[] = ['python3', 'python'];
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

	private runCmd(cmd: string, args: string[], cwd: string, log: (m: string) => void): Promise<boolean> {
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
}
