# HTTP API

Base URL: `http://127.0.0.1:4747`. All request/response bodies are JSON unless
noted. Errors are always `{ "error": string }` with an appropriate status code.

## Pages & previews

| Method | Path | Description |
|---|---|---|
| GET | `/` | Marketing page |
| GET | `/agent` | Workspace app |
| GET | `/preview/:id/*` | Serves project files statically (`index.html` default, `Cache-Control: no-store`). If the project has a running process that accepts connections, the preview proxies to it instead. |

## System

### `GET /api/health`

```json
{ "ok": true, "ollama": true, "ollamaHost": "http://localhost:11434" }
```

### `GET /api/models`

Chat-capable models installed in Ollama (embedding models are filtered out).

```json
{ "models": [ { "name": "qwen3.6:35b-a3b-q4_K_M", "size": 23938333577, "family": "qwen35moe", "params": "36.0B" } ] }
```

`502` if Ollama is unreachable.

## Projects

### `GET /api/projects`

```json
{ "projects": [ { "id": "mock-app-3f2a", "name": "Mock App", "description": "…", "createdAt": 0, "updatedAt": 0, "model": "…" } ] }
```

### `POST /api/projects`

Create a project. `files` is optional (used by import).

```json
{ "name": "My App", "description": "optional brief", "files": [ { "path": "index.html", "content": "…" } ] }
```

Returns `201` with the project metadata. Ids are slugs: `my-app-3f2a`.

### `PATCH /api/projects/:id` — update `name` / `description`.
### `DELETE /api/projects/:id` — delete the project folder permanently.

## Files

### `GET /api/projects/:id/files`

Everything the workspace needs to open a project:

```json
{ "files": [ { "path": "index.html", "size": 5132 } ], "chat": [ … ], "meta": { … } }
```

### `GET /api/projects/:id/file?path=rel/path`
### `PUT /api/projects/:id/file?path=rel/path` — body `{ "content": "…" }`
### `DELETE /api/projects/:id/file?path=rel/path`

All paths are traversal-checked; escaping the project folder returns `400`.

## Agent chat

### `POST /api/projects/:id/chat`

Body: `{ "message": "build a pomodoro timer", "model": "qwen3.6:35b-a3b-q4_K_M" }`

Response: `application/x-ndjson` — one JSON event per line, streamed while the
model works. Files are written to disk the moment their block completes.

| Event | Payload | Meaning |
|---|---|---|
| `thinking` | `{text}` | Reasoning tokens (thinking-capable models) |
| `token` | `{text}` | Narration addressed to the user |
| `fileStart` | `{path}` | A file block began |
| `fileChunk` | `{path, bytes, text}` | Progress inside a file block; `text` is the newly streamed slice |
| `fileDone` | `{path, bytes, truncated}` | File written to disk |
| `deleted` | `{path}` | File removed |
| `run` | `{command}` | The agent requested a console command |
| `runResult` | `{command, ok, code, timedOut, output}` | The command ran; its output goes back to the model for another round |
| `error` | `{message}` | Non-fatal problem this turn |
| `done` | `{files, runs, turn, ms}` | Turn complete; `turn` is the checkpoint id (null if no files changed) |

A turn can span several model rounds: when the agent emits `<<<RUN: command>>>`
markers, the commands execute (same allowlist as `/exec`) after its reply
finishes, the output is appended to the conversation, and the model is called
again, up to `REPLICA_AGENT_MAX_ITERS` rounds (default 3).

Aborting the request (client disconnect) aborts the upstream Ollama call;
whatever was produced up to that point is persisted with an `(interrupted)`
marker in the history.

Example:

```bash
curl -N localhost:4747/api/projects/my-app-3f2a/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"add a dark mode toggle","model":"qwen3.6:35b-a3b-q4_K_M"}'
```

```
{"type":"thinking","text":"The user wants a toggle…"}
{"type":"token","text":"I'll add a toggle to the header."}
{"type":"fileStart","path":"index.html"}
{"type":"fileDone","path":"index.html","bytes":5240,"truncated":false}
{"type":"done","files":[{"op":"write","path":"index.html","bytes":5240}],"ms":41200}
```

## Checkpoints

Every agent turn that touches files snapshots the pre-turn version of each
touched file first. The 50 most recent checkpoints are kept per project.

### `GET /api/projects/:id/checkpoints`

Newest first:

```json
{ "checkpoints": [ { "id": "mc41x2-9f3a", "at": 1751980000000, "message": "add a dark mode toggle", "files": 2 } ] }
```

### `POST /api/projects/:id/rollback`

Body: `{ "turn": "mc41x2-9f3a" }`. Restores the project files to the state
before that turn by unwinding every checkpoint from the newest down to and
including the target. Consumed checkpoints are removed (undo, no redo), and a
rollback note is appended to the chat history so the agent knows.

```json
{ "ok": true, "undone": 2 }
```

`404` if the checkpoint does not exist.

## Console

### `POST /api/projects/:id/exec`

Body: `{ "command": "node script.js" }`. Commands must start with an
allowlisted runtime (`node`, `python`/`python3`/`py`, `pip`, `npm`, `npx`),
must not contain shell metacharacters (`;`, `&`, `|`, `<`, `>`, backticks,
`$(`, newlines), and run with the project folder as cwd, subject to
`REPLICA_EXEC_TIMEOUT` (60 s default).

```json
{ "ok": true, "code": 0, "timedOut": false, "output": "42\n" }
```

Disallowed commands return `400`.

## Run (long-lived process)

One dev server per project. The child process gets a free port in its `PORT`
environment variable; once it accepts connections on that port, `/preview/:id/*`
proxies to it (static file serving resumes when the process stops).

### `POST /api/projects/:id/run`

Body: `{ "command": "node server.js" }` (same allowlist as `/exec`). Restarts
the process if one is already running and remembers the command in the project
metadata (`meta.runCommand`).

```json
{ "ok": true, "running": true, "up": false, "command": "node server.js", "port": 52144, "startedAt": 1751980000000, "exitCode": null }
```

### `GET /api/projects/:id/run` — current status (same shape, no `ok`).

### `POST /api/projects/:id/stop` — tree-kills the process.

### `GET /api/projects/:id/logs?after=N`

Incremental output read; `lines[].i` is a monotonic cursor, pass the returned
`last` back as `after`. Streams are `out`, `err`, and `sys` (Replica's own
markers such as start/exit lines). The newest 2000 lines are kept.

```json
{ "lines": [ { "i": 1, "s": "sys", "text": "$ node server.js  (PORT=52144)" } ], "last": 1, "running": true, "up": true }
```
