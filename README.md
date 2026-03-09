# Vizier
<img width="344" height="651" alt="image" src="https://github.com/user-attachments/assets/bfb34136-a6b9-45cf-9f4f-71c9b51dda01" />

A local, privacy-first AI agent for Obsidian powered by [Ollama](https://ollama.com). Does what you ask — chat, write notes, search your vault, summarize videos and articles. Everything runs on your machine — no cloud accounts, no API keys, no telemetry.

## Features

| Command | What it does |
|---|---|
| `/write <topic>` | Generate a structured note with AI-suggested filename, tags, and body |
| `/find <query>` | Natural-language search across your vault |
| `/summarize <url>` | Summarize a YouTube video or web article |
| `/clip <url>` | Fetch, summarize, and save a URL to your Clips folder |
| `/clip long <url>` | Clip with detailed notes — ideal for lectures or classes |
| `/read` | Summarize or ask a question about the active note |
| Free chat | Stream a conversation with any Ollama model |

All commands are also available from the **Command Palette** (Cmd/Ctrl+P).

## Requirements

- [Ollama](https://ollama.com) running locally (`ollama serve`)
- At least one model pulled, e.g. `ollama pull gemma3:4b`
- Desktop only (uses Node.js child_process for the transcript server)

## YouTube transcripts

YouTube summarization requires a small local Python server (`transcript_server.py`).

**One-click setup:** Open the Command Palette and run **"Setup / start transcript server"**. The modal will detect Python, create a virtual environment, install `youtube-transcript-api`, and start the server automatically.

**Manual setup (fallback):**
```bash
python3 -m venv .venv
.venv/bin/pip install youtube-transcript-api
.venv/bin/python3 transcript_server.py
```

## Article fetching

Articles are fetched via [Jina AI Reader](https://jina.ai/reader/) (`r.jina.ai`), a free public service that returns clean markdown from any URL. It handles JavaScript-rendered pages, encoding issues, and common paywalls far better than raw HTML scraping. No API key is required, but an outbound request to `r.jina.ai` is made for each article.

## Settings

| Setting | Default | Description |
|---|---|---|
| Ollama URL | `http://localhost:11434` | Base URL of your Ollama instance |
| Default model | `gemma3:4b` | Model used for all AI tasks |
| Transcript server URL | `http://127.0.0.1:11435` | URL of the local transcript server |
| Clips folder | `Clips` | Vault folder where `/clip` saves notes |
| AI notes folder | *(empty)* | Vault folder where `/write` saves notes (empty = Obsidian default) |

## Building

```bash
npm install
npm run build   # production
npm run dev     # watch mode
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.

## Privacy

- All AI inference runs locally via Ollama.
- The only outbound request is to `r.jina.ai` when fetching articles (the URL you provide is sent).
- YouTube transcripts are fetched locally via `youtube-transcript-api` — no third-party service.
- No analytics, no telemetry, no cloud sync.
