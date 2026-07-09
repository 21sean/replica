# Changelog

## Unreleased

- Real publishing: `published` lives in project metadata and gates stable
  `/apps/<project>/` URLs (static or proxied to the running process); the
  Published Projects view links and copies those URLs
- Workspace state (profile, prefs, workspace name, model) moved server-side to
  `projects/workspace.json` with one-time migration from localStorage, so
  every browser sees the same workspace
- Syntax-highlighted editor: a zero-dependency tokenizer (JS/TS, CSS, HTML,
  JSON, Python) rendered under a transparent textarea, so editing behavior is
  unchanged; `fileChunk` chat events now carry the streamed text and the Code
  tab shows files assembling live as the agent writes them
- Agent RUN loop: `<<<RUN: command>>>` markers execute allowlisted commands
  mid-turn and feed the output back to the model for up to
  `REPLICA_AGENT_MAX_ITERS` rounds, so the agent can verify and fix its own
  work; run results render in chat with expandable output
- Preview error bridge: runtime errors in statically served previews report
  back to the workspace with a one-click Fix with Agent prompt
- Run button: start a long-lived dev server per project (`POST /run`, `/stop`,
  incremental `/logs`); the process gets a free port via `PORT` and the
  preview proxies to it once it accepts connections, so Node and Python
  server apps preview like static sites
- Per-turn checkpoints: every agent turn snapshots the files it touches before
  writing, and a Restore checkpoint button on each turn rolls the project back
  (`GET /checkpoints`, `POST /rollback`)
- Chat history is trimmed oldest-first to fit the model context window
  (`REPLICA_CTX_RESERVE` controls the reply reserve); long sessions no longer
  silently overflow `num_ctx`
- Console commands now reject shell metacharacters (`;`, `&`, `|`, `<`, `>`,
  backticks, `$(`, newlines), closing the chaining bypass of the runtime
  allowlist

## 0.1.0 — 2026-07-07

Initial release.

- Marketing landing page (`/`) with a functional prompt hand-off into the workspace
- Agent workspace (`/agent`): onboarding, home, projects, and a full IDE view
  (agent chat · live preview · code editor · console)
- Streaming agent pipeline over Ollama: thinking channel, narration, and
  file blocks written to disk mid-stream with truncation flagging
- Per-turn context rebuilt from the live project files; compacted chat history
- Project store: plain folders with `.replica/` metadata; import, delete, rename
- Console command runner (allowlisted local runtimes, timeout, output cap)
- Environment-driven config; loopback binding by default; graceful shutdown
- Unit + integration test suite (`node:test`, mocked Ollama); CI matrix across
  Linux/Windows/macOS on Node 20/22
- Zero npm dependencies throughout
