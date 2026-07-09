# Security model

Replica is a **personal, single-user, localhost tool**. It is designed to be run
by you, for you, on your own machine — not deployed as a service. The measures
below are defense-in-depth for that scenario, not multi-tenant isolation.

## What Replica does

- **Binds to loopback by default.** The server listens on `127.0.0.1` unless you
  explicitly set `HOST=0.0.0.0`. Nothing is reachable from your network out of
  the box.
- **Path traversal guards everywhere.** Every user- or model-supplied path
  (file API, previews, agent file writes/deletes) is resolved through a single
  `safeJoin` helper that rejects `..` escapes, absolute paths, and drive-letter
  paths. The agent cannot write outside its project folder.
- **Console command allowlist.** `/exec` only accepts commands starting with
  local runtimes (`node`, `python`, `npm`, …), runs them with the project as
  cwd, and enforces a timeout and output cap. Shell metacharacters
  (`;`, `&`, `|`, `<`, `>`, backticks, `$(`, newlines) are rejected outright,
  so an allowlisted prefix cannot chain into arbitrary commands.
- **Sandboxed previews.** Generated apps render in an iframe with a `sandbox`
  attribute; preview responses are served `Cache-Control: no-store` with
  `X-Content-Type-Options: nosniff`.
- **No outbound traffic except Ollama.** The server talks to exactly one
  upstream: your configured `OLLAMA_HOST`. There is no telemetry, no update
  check, no analytics.

## What Replica does not defend against

Be aware of these before changing the defaults:

- **The console is code execution by design.** `node script.js` runs with your
  user's privileges. The allowlist prevents *accidental* shell commands, not a
  determined attacker who can already write project files. Treat generated code
  the way you'd treat code from any untrusted source: read it before running it
  outside the sandboxed preview.
- **Previews share the server's origin.** A generated app's JavaScript runs
  sandboxed but same-origin, so a hostile generated app could call the local
  API. If that matters to you, review generated code before opening previews,
  or run Replica under a separate OS user.
- **`HOST=0.0.0.0` exposes everything.** Anyone who can reach the port can
  create projects and run allowlisted commands. Only expose Replica on networks
  where you trust every device, ideally behind an authenticating reverse proxy.

## Reporting

If you find a vulnerability that violates the model above, please open a GitHub
issue (or a private security advisory) with reproduction steps.
