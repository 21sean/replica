# Changelog

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
