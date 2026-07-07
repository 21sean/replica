# Replica — your own local Replit

A personal, fully local Replit-style workspace: a marketing page plus a working
AI Agent that builds real apps on your disk, powered by the Ollama models you
already run. No accounts, no credits, no cloud, no telemetry — all the sales
stuff removed.

## Run it

```
node server.js
```

That's it — zero npm dependencies (Node 18+). Then open:

| URL | What |
|---|---|
| http://localhost:4747/ | Marketing page |
| http://localhost:4747/agent | Agent workspace |

Requirements: [Ollama](https://ollama.com) running locally with at least one
chat model pulled (e.g. `ollama pull qwen3.6:35b-a3b-q4_K_M`).

## What the workspace does

- **Home** — "Hi, what do you want to make?" Describe an idea; a project is
  created and the Agent starts building. Category chips and example prompts
  included, plus a model picker (any chat-capable Ollama model).
- **Agent chat** — streams the model's thinking (collapsible), its plan, and
  every file it writes with live ✓ progress. Keep chatting to iterate; the
  Agent sees the current state of all project files each turn, including your
  manual edits.
- **Preview tab** — the project served live in an iframe (auto-refreshes as
  files land). Open in a new tab with ↗.
- **Code tab** — file tree + editor with line numbers, Tab indent, Ctrl+S save,
  new/delete file.
- **Console tab** — run `node …` / `python …` / `npm …` inside the project
  folder (60s timeout).
- **Projects** — every project is a plain folder in `replica/projects/` you can
  open in any editor, back up, or git-init.
- **Onboarding + Settings** — username, full name, role, default model
  (stored in localStorage). No billing, promotions, or upgrade anywhere.

## How the Agent works

The server builds a system prompt containing the full current project file
contents, streams the chat through Ollama (`/api/chat`), and parses the
response live for file blocks:

```
<<<FILE: path/to/file.ext>>>
...complete file contents...
<<<END FILE>>>
```

Files are written to disk the moment each block completes, so you watch the
app assemble itself. `<<<DELETE: path>>>` removes files. Thinking output
(qwen3/gemma thinking models) is streamed to a collapsible block.

## Config

- `PORT` — server port (default 4747)
- `OLLAMA_HOST` — Ollama base URL (default `http://localhost:11434`)

```
set PORT=5000 && set OLLAMA_HOST=http://192.168.1.10:11434 && node server.js
```

## Layout

```
replica/
  server.js        the whole backend (no dependencies)
  public/
    index.html     marketing page
    agent.html/.css/.js   workspace app
  projects/        your generated projects (plain folders)
```
