'use strict';

/**
 * Claude provider that shells out to the locally-installed `claude` CLI in
 * print mode. This is the "frictionless" BYO-model path: it piggy-backs on
 * whatever the user already logged in with (`claude login` / a Pro/Max
 * subscription), so there is no API key to paste. The CLI owns token refresh
 * and the OAuth plumbing; we never touch the credential.
 *
 * We drive Claude Code as a pure text generator, NOT as an autonomous agent:
 * its own tools, MCP servers, skills, and settings are stripped so the model
 * simply emits Replica's file-write protocol (<<<FILE>>> / <<<RUN>>> …) the
 * same way a local Ollama model does. The streaming events are normalised to
 * the same shape Replica already consumes from Ollama:
 *   { message: { content?, thinking? } }  and  { error }
 *
 * Hardening (spawn flags, Windows .exe, tmpdir cwd, no --bare so OAuth still
 * works) follows a proven implementation; see comments inline.
 */

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const config = require('./../config');
const log = require('./../log');

// Curated catalog. The CLI has no "list models" command and no API key, so a
// static list is the only source. Ids are the real --model values.
const MODELS = [
  { model: 'claude-opus-4-8', label: 'Claude Opus 4.8', params: 'most capable' },
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', params: 'balanced' },
  { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', params: 'fastest' },
];

function bin() {
  return config.claude.bin;
}

/** Is the `claude` binary present? (Auth is checked lazily, at call time.) */
async function detect() {
  if (!config.claude.enabled) return { available: false, reason: 'disabled' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin(), ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    } catch {
      return resolve({ available: false, reason: 'not installed' });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ available: false, reason: 'timeout' }); }, 4000);
    child.on('error', () => { clearTimeout(timer); resolve({ available: false, reason: 'not installed' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ available: code === 0 }); });
  });
}

function listModels() {
  return MODELS.map((m) => ({
    id: 'claude:' + m.model,
    provider: 'claude',
    model: m.model,
    name: m.model,
    label: m.label,
    params: m.params,
    sub: 'Claude subscription',
  }));
}

/**
 * Split Replica's message array into a single system prompt (all system-role
 * messages joined) plus a flat human transcript for stdin. Claude's print mode
 * takes exactly one system prompt and one prompt, so history is folded into a
 * labelled transcript. The system prompt goes to a temp file (it embeds the
 * whole project and can far exceed the OS command-line length limit).
 */
function splitMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else turns.push(`## ${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}\n${m.content}`);
  }
  return { systemPrompt: system.join('\n\n'), userPrompt: turns.join('\n\n') };
}

/**
 * Map one parsed stream-json line to zero or more Replica events. Pure and
 * exported so it can be unit-tested without spawning the CLI.
 */
function parseStreamLine(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'stream_event' && obj.event && obj.event.type === 'content_block_delta') {
    const d = obj.event.delta || {};
    if (d.type === 'text_delta' && d.text) return [{ message: { content: d.text } }];
    if (d.type === 'thinking_delta' && d.thinking) return [{ message: { thinking: d.thinking } }];
    return [];
  }
  if (obj.type === 'result' && obj.is_error === true) {
    const msg = typeof obj.result === 'string' ? obj.result : 'claude CLI error';
    if (/not logged in|please run \/login|authentication/i.test(msg)) {
      return [{ error: 'Claude CLI is not logged in. Run `claude login` in a terminal, then retry.' }];
    }
    return [{ error: msg.slice(0, 300) }];
  }
  return [];
}

/** Minimal async queue bridging spawn's event stream to an async iterator. */
function createQueue() {
  const buf = [];
  let waiting = null;
  let closed = false;
  return {
    push(v) { if (waiting) { const w = waiting; waiting = null; w({ value: v, done: false }); } else buf.push(v); },
    close() { closed = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { waiting = resolve; });
    },
  };
}

/**
 * Stream a chat completion from the `claude` CLI. Async generator yielding
 * Replica-shaped events. Throws on spawn failure.
 */
async function* chatStream({ model, messages, signal }) {
  const { systemPrompt, userPrompt } = splitMessages(messages);
  const tmpFile = path.join(os.tmpdir(), `replica-claude-sys-${process.pid}-${Date.now()}.txt`);
  await fsp.writeFile(tmpFile, systemPrompt, 'utf8');

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Replace Claude Code's ~70k-token agent bootstrap with just our protocol.
    '--system-prompt-file', tmpFile,
    // Strip everything that would make it act as an agent or bloat the prompt:
    '--tools', '',              // no built-in tool schemas (needs shell:false to keep the empty arg)
    '--strict-mcp-config',      // ignore user MCP servers
    '--disable-slash-commands', // no skill summaries
    '--setting-sources', 'project', // spawned in tmpdir → effectively loads nothing
    '--effort', config.claude.effort,
  ];
  if (model) args.push('--model', model);

  const child = spawn(bin(), args, {
    // Neutral cwd so the CLI does not auto-load project memory / CLAUDE.md.
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.claude.maxOutputTokens) },
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell:false so each argv entry is preserved verbatim — cmd.exe would drop
    // the empty-string `--tools ""` arg and re-enable the full tool prompt.
    shell: false,
  });

  const queue = createQueue();
  let stderr = '';
  let sawContent = false;
  let ended = false;
  const finish = () => { if (!ended) { ended = true; queue.close(); } };

  const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = config.claude.timeoutMs > 0
    ? setTimeout(() => { queue.push({ error: `Claude CLI did not respond within ${config.claude.timeoutMs / 1000}s` }); onAbort(); }, config.claude.timeoutMs)
    : null;

  let lineBuf = '';
  child.stdout.on('data', (b) => {
    lineBuf += b.toString('utf8');
    let nl;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const ev of parseStreamLine(obj)) {
        if (ev.message && ev.message.content) sawContent = true;
        queue.push(ev);
      }
    }
  });
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  child.on('error', (err) => {
    if (ended) return;
    queue.push({ error: err.code === 'ENOENT'
      ? "`claude` CLI not found. Install Claude Code, or set REPLICA_CLAUDE_BIN."
      : String(err) });
    finish();
  });
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    if (!ended && code !== 0 && !sawContent) {
      queue.push({ error: `claude exited ${code}: ${stderr.trim().slice(0, 300) || 'no output'}` });
    }
    finish();
  });

  try { child.stdin.end(userPrompt); } catch (e) { queue.push({ error: `failed to write to claude: ${e.message}` }); finish(); }

  try {
    for await (const ev of queue) yield ev;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    fsp.unlink(tmpFile).catch(() => { /* best effort */ });
    log.debug('claude cli stream ended');
  }
}

module.exports = { detect, listModels, chatStream, parseStreamLine, splitMessages };
