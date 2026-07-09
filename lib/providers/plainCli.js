'use strict';

/**
 * Generic provider for CLIs that, in non-interactive print mode, stream a
 * plain-text answer to stdout. Used for the Gemini CLI (`gemini`) and the
 * GitHub Copilot CLI (`copilot`) — both let a developer authenticate once
 * (Google / GitHub login) and then reuse that session with no API key, which
 * is the same frictionless story as the Claude provider.
 *
 * Unlike Claude's stream-json envelope these CLIs emit raw text, so every
 * stdout chunk is forwarded verbatim as a content event. The whole prompt
 * (system + transcript) is fed on stdin to avoid OS command-line length limits.
 *
 * NOTE: unlike the Claude provider, these two adapters have NOT been verified
 * end-to-end (the CLIs were not installed in the build environment). They are
 * gated behind binary detection, so they simply never appear in the model
 * picker until the corresponding CLI is present; wiring is best-effort per each
 * tool's documented print-mode flags and may need a tweak once exercised.
 */

const { spawn } = require('child_process');
const config = require('./../config');
const log = require('./../log');

function flatten(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') system.push(m.content);
    else turns.push(`## ${m.role === 'assistant' ? 'ASSISTANT' : 'USER'}\n${m.content}`);
  }
  const parts = [];
  if (system.length) parts.push(system.join('\n\n'));
  if (turns.length) parts.push(turns.join('\n\n'));
  return parts.join('\n\n---\n\n');
}

/** Build a plain-text streaming CLI provider from a small spec. */
function makeProvider(spec) {
  // spec: { id, label, cfg (config.<name>), catalog: [{model,label,params}], args(model) }
  function detect() {
    if (!spec.cfg.enabled) return Promise.resolve({ available: false, reason: 'disabled' });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spec.cfg.bin, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], shell: false });
      } catch {
        return resolve({ available: false, reason: 'not installed' });
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ available: false, reason: 'timeout' }); }, 4000);
      child.on('error', () => { clearTimeout(timer); resolve({ available: false, reason: 'not installed' }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ available: code === 0 }); });
    });
  }

  function listModels() {
    return spec.catalog.map((m) => ({
      id: `${spec.id}:${m.model}`,
      provider: spec.id,
      model: m.model,
      name: m.model,
      label: m.label,
      params: m.params || '',
      sub: spec.sub,
    }));
  }

  async function* chatStream({ model, messages, signal }) {
    const prompt = flatten(messages);
    const child = spawn(spec.cfg.bin, spec.args(model), {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const buf = [];
    let waiting = null;
    let closed = false;
    const push = (v) => { if (waiting) { const w = waiting; waiting = null; w(); } buf.push(v); };
    const nextItem = () => new Promise((resolve) => {
      if (buf.length || closed) return resolve();
      waiting = resolve;
    });

    const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }

    let stderr = '';
    child.stdout.on('data', (b) => push({ message: { content: b.toString('utf8') } }));
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => { push({ error: err.code === 'ENOENT' ? `\`${spec.cfg.bin}\` not found` : String(err) }); closed = true; if (waiting) { const w = waiting; waiting = null; w(); } });
    child.on('close', (code) => {
      if (code !== 0) push({ error: `${spec.id} exited ${code}: ${stderr.trim().slice(0, 300) || 'no output'}` });
      closed = true; if (waiting) { const w = waiting; waiting = null; w(); }
    });

    try { child.stdin.end(prompt); } catch (e) { push({ error: `failed to write to ${spec.id}: ${e.message}` }); closed = true; }

    try {
      for (;;) {
        if (!buf.length) { if (closed) break; await nextItem(); if (!buf.length && closed) break; }
        yield buf.shift();
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      log.debug(`${spec.id} cli stream ended`);
    }
  }

  return { id: spec.id, label: spec.label, detect, listModels, chatStream };
}

// Gemini CLI: `gemini -m <model>`, prompt on stdin, plain-text stream on stdout.
const gemini = makeProvider({
  id: 'gemini',
  label: 'Gemini',
  cfg: config.gemini,
  sub: 'Google login',
  catalog: [
    { model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', params: 'most capable' },
    { model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', params: 'fast' },
  ],
  args: (model) => (model ? ['-m', model] : []),
});

// GitHub Copilot CLI: `copilot -p` reads the prompt; agentic output on stdout.
const copilot = makeProvider({
  id: 'copilot',
  label: 'Copilot',
  cfg: config.copilot,
  sub: 'GitHub login',
  catalog: [
    { model: 'claude-sonnet-4.5', label: 'Copilot (Claude Sonnet 4.5)', params: '' },
    { model: 'gpt-5', label: 'Copilot (GPT-5)', params: '' },
  ],
  args: (model) => (model ? ['--model', model] : []),
});

module.exports = { gemini, copilot, makeProvider };
