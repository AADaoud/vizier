# Vizier
<div align="center">
  <img width="761" height="351" alt="Screenshot from 2026-03-11 02-44-49"
    src="https://github.com/user-attachments/assets/0786a8bb-141b-42a5-9bc4-de19967c2115" />
</div>

A local, privacy-first AI agent for Obsidian powered by [Ollama](https://ollama.com). Chat, write notes, search your vault, summarize videos and articles, and digitize handwritten notes — everything runs on your machine. No cloud accounts, no API keys, no telemetry. Completely free and open source.

## Features

| Command | What it does |
|---|---|
| `/write <topic>` | Generate a structured note with AI-suggested filename, tags, and body |
| `/find <query>` | Natural-language search across your vault |
| `/summarize <url>` | Summarize a YouTube video or web article |
| `/clip <url>` | Fetch, summarize, and save a URL to your Clips folder |
| `/clip long <url>` | Clip with detailed notes — ideal for long commentaries or reads |
| `/clip learn <url>` | Clip with detailed notes plus a study guide popup — ideal for lectures |
| `/read` | Summarize or ask a question about the active note |
| `/handwriting` | OCR a photo of handwritten notes and save as a vault note |
| Free chat | Stream a conversation with any Ollama model |

All commands are also available from the **Command Palette** (Cmd/Ctrl+P).

## Requirements

- [Ollama](https://ollama.com) running locally (`ollama serve`)
- At least one model pulled, e.g. `ollama pull gemma3:4b`
- Desktop only (uses Node.js child_process for the Vizier server)

## Setup

### Ollama

1. Install [Ollama](https://ollama.com) and start it: `ollama serve`
2. Pull a model: `ollama pull gemma3:4b` (or any model you prefer)
3. Set the model name in **Settings → Vizier → Default model**

### YouTube transcripts & handwriting OCR

These features require a small local Python server (`vizier_server.py`) that runs alongside Obsidian.

**One-click setup:** Open the Command Palette and run **"Vizier: Setup / start Vizier server"**. The modal will detect Python 3, create a virtual environment, install dependencies, and start the server automatically.

On first use of `/handwriting`, you will be prompted to download the OCR model files (~1.5 GB including PyTorch). This is a one-time download.

**Manual setup (fallback):**
```bash
cd <vault>/.obsidian/plugins/vizier
python3 -m venv .venv
.venv/bin/pip install youtube-transcript-api
.venv/bin/python3 vizier_server.py
```

The server runs on `http://127.0.0.1:11435`. You can change this in settings.

## Article fetching

Articles are fetched via [Jina AI Reader](https://jina.ai/reader/) (`r.jina.ai`), a free public service that returns clean markdown from any URL. No API key required. The only data sent is the URL you provide.

## Settings

| Setting | Default | Description |
|---|---|---|
| Ollama URL | `http://localhost:11434` | Base URL of your Ollama instance |
| Default model | `gemma3:4b` | Model used for all AI tasks |
| Vizier server URL | `http://127.0.0.1:11435` | URL of the local Vizier server |
| Clips folder | `Clips` | Vault folder where `/clip` saves notes |
| AI notes folder | *(empty)* | Vault folder where `/write` saves notes (empty = vault root) |
| Handwritten notes folder | *(empty)* | Vault folder where `/handwriting` saves notes |

## Building from source

```bash
git clone https://github.com/your-username/vizier
cd vizier
npm install --legacy-peer-deps
npm run build   # production
npm run dev     # watch mode
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.

## FAQ

---

**Do I need an internet connection?**

Only for `/summarize`/`/clip` (fetches the article/transcript) and article fetching via Jina. All AI inference runs fully offline via Ollama.

---

**What model should I use?**

`gemma3:4b` is a good default — fast, capable, and runs on most machines. For better quality on longer documents try `gemma3:12b` or `mistral`. Any Ollama-compatible model works.

---

**The Vizier server won't start — what do I check?**

Make sure Python 3 is installed (`python3 --version`). If setup fails mid-way, delete the `.venv` folder inside the plugin directory and run **"Vizier: Setup / start Vizier server"** again.

---

**OCR results are inaccurate — can I improve them?**

Results depend on image quality. Ensure the photo is well-lit with minimal skew. After OCR, Vizier automatically runs a cleanup pass through your Ollama model to fix spacing and punctuation.

---

**Port 11435 is already in use.**

Change the **Vizier server URL** in settings to use a different port (e.g. `http://127.0.0.1:11436`), then restart the server.

---

## Privacy

- All AI inference runs locally via Ollama — nothing leaves your machine.
- The only outbound requests are to `r.jina.ai` when fetching articles (the URL you provide is sent).
- YouTube transcripts are fetched locally via `youtube-transcript-api` — no third-party service.
- No analytics, no telemetry, no cloud sync.
