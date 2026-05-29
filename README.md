# Vizier
<div align="center">
  <img width="761" height="351" alt="Screenshot from 2026-03-11 02-44-49"
    src="https://github.com/user-attachments/assets/0786a8bb-141b-42a5-9bc4-de19967c2115" />
</div>

A local, privacy-first AI agent for Obsidian powered by [Ollama](https://ollama.com). Chat, write notes, search your vault, summarize videos and articles, build a knowledge graph of people and entities, reflect on your notes, and digitize handwritten content — everything runs on your machine. No cloud accounts, no API keys, no telemetry. Completely free and open source.

## Features

### Writing & editing

| Command | What it does |
|---|---|
| `/write <topic>` | Generate a structured note with AI-suggested filename, tags, and body |
| `/edit <instruction>` | Edit the active note following an AI instruction |
| `/read` | Summarize or ask a question about the active note |
| Free chat | Stream a conversation with any Ollama model |
| Add AI abstract callout | Insert an AI-generated summary callout at the top of the active note (palette only) |

### Web & media

| Command | What it does |
|---|---|
| `/summarize <url>` | Summarize a YouTube video or web article |
| `/clip <url>` | Fetch, summarize, and save a URL to your Clips folder |
| `/clip long <url>` | Clip with detailed notes — ideal for long commentaries or reads |
| `/clip learn <url>` | Clip with detailed notes plus a study guide popup — ideal for lectures |
| `/transcribe <file or url>` | Transcribe an audio file or podcast URL via Whisper |
| `/ingest <path>` | Ingest a book or PDF chapter-by-chapter into your vault |
| `/handwriting` | OCR a photo of handwritten notes and save as a vault note |

### Human Network

Build a knowledge graph of people, events, ideas, and entities inside your vault.

| Command | What it does |
|---|---|
| `/person <name>` | Create a person note with biography and Wikipedia data |
| `/event <title>` | Create a historical event note with date, context, and Wikipedia data |
| `/idea <concept>` | Create a concept or theory note with definition and Wikipedia data |
| `/entity <type> \| <name>` | Create a note for any entity type (organization, place, movement, etc.) |
| `/link A \| B` | Add a bidirectional link between two entity notes |
| `/bridge A \| B` | Find the shortest connection path between two entities |
| `/timeline <topic or range>` | Build a chronological timeline (e.g. `/timeline Cold War` or `/timeline 1939..1945`) |

Entity notes are organized into sub-folders by type (e.g. `Human Network/Entities/organization/NATO.md`). Wikipedia is searched first; if no result is found, a manual-entry prompt appears.

### Analysis & research

| Command | What it does |
|---|---|
| `/find <query>` | Natural-language search across your vault |
| `/standardize <folder>` | Add missing metadata to all notes in a folder |
| `/recluster <folder>` | Cluster notes in a folder into themes |
| `/contradict` | Find contradictions in the active note — checks vault notes and model knowledge |
| `/sources` | Audit the active note for uncited factual claims |
| `/socratic` | Generate Socratic questions for the active note and capture your answers |
| `/thesis <tag>` | Build a structured thesis document from tagged notes |

`/contradict` outputs two sections: **From vault** (notes in your vault that conflict with the active note's claims) and **From model knowledge** (well-established facts from the model's training that conflict).

### Reflection

| Command | What it does |
|---|---|
| `/weekly` | Generate a weekly reflection scaffold from notes modified this week |
| `/monthly` | Generate a monthly reflection scaffold from notes modified this month |
| `/freewrite` | Open a new timestamped blank note for free writing |

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

### YouTube transcripts, Wikipedia lookups & handwriting OCR

These features require a small local Python server (`vizier_server.py`) that runs alongside Obsidian.

**One-click setup:** Open the Command Palette and run **"Vizier: Setup / start Vizier server"**. The modal will detect Python 3, create a virtual environment, install dependencies, and start the server automatically. If the server is already running from a previous session, clicking Start will detect this and confirm without restarting.

On first use of `/handwriting`, you will be prompted to download the OCR model files (~1.5 GB including PyTorch). This is a one-time download.

**Manual setup (fallback):**
```bash
cd <vault>/.obsidian/plugins/vizier
python3 -m venv .venv
.venv/bin/pip install youtube-transcript-api wikipedia-api
.venv/bin/python3 vizier_server.py
```

The server runs on `http://127.0.0.1:11435`. You can change this in settings.

## Article fetching

Articles are fetched via [Jina AI Reader](https://jina.ai/reader/) (`r.jina.ai`), a free public service that returns clean markdown from any URL. No API key required. The only data sent is the URL you provide. If Jina is unavailable, Vizier falls back to a raw HTML fetch.

## Settings

| Setting | Default | Description |
|---|---|---|
| Ollama URL | `http://localhost:11434` | Base URL of your Ollama instance |
| Default model | `gemma3:4b` | Model used for all AI tasks |
| Vizier server URL | `http://127.0.0.1:11435` | URL of the local Vizier server |
| Clips folder | `Clips` | Vault folder where `/clip` saves notes |
| AI notes folder | *(empty)* | Vault folder where `/write` saves notes (empty = vault root) |
| Handwritten notes folder | `Handwritten Notes` | Vault folder where `/handwriting` saves notes |
| People folder | `Human Network/People` | Vault folder where `/person` saves notes |
| Events folder | `Human Network/Events` | Vault folder where `/event` saves notes |
| Ideas folder | `Human Network/Ideas` | Vault folder where `/idea` saves notes |
| Entities folder | `Human Network/Entities` | Vault folder where `/entity` saves notes (sub-foldered by type) |
| Timeline folders | `Human Network/Events, Human Network/People, Human Network/Ideas` | Comma-separated folders `/timeline` searches |
| Reflections folder | `Reflections` | Vault folder where `/weekly`, `/monthly`, and `/freewrite` save notes |
| Books folder | `Books` | Vault folder where `/ingest` saves processed book notes |
| Transcripts folder | `Transcripts` | Vault folder where `/transcribe` saves audio transcripts |
| Theses folder | `Theses` | Vault folder where `/thesis` saves structured documents |
| Whisper model | `base` | Model size for audio transcription (`tiny` / `base` / `small` / `medium`) |
| Max notes per recluster | `100` | Maximum notes `/recluster` will process (most recent by modification date) |

## Building from source

```bash
git clone https://github.com/AADaoud/vizier
cd vizier
npm install --legacy-peer-deps
npm run build   # production
npm run dev     # watch mode
```

Release artifacts: `main.js`, `manifest.json`, `styles.css`.

## FAQ

---

**Do I need an internet connection?**

Only for `/summarize`/`/clip` (fetches the article/transcript via Jina), `/person`/`/event`/`/idea`/`/entity` (Wikipedia lookup), and `/transcribe` with a podcast URL. All AI inference runs fully offline via Ollama.

---

**What model should I use?**

`gemma3:4b` is a good default — fast, capable, and runs on most machines. For better quality on longer documents try `gemma3:12b` or `mistral`. Any Ollama-compatible model works.

---

**The Vizier server won't start — what do I check?**

Make sure Python 3 is installed (`python3 --version`). If setup fails mid-way, delete the `.venv` folder inside the plugin directory and run **"Vizier: Setup / start Vizier server"** again. The server auto-detects if it's already running, so clicking Start when the server is up will simply confirm it's available.

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
- `en.wikipedia.org` is queried when using Human Network commands — only the name or title you provide is sent. No API key required.
- No analytics, no telemetry, no cloud sync.
