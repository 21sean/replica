'use strict';

/** JSON API routes, including the streaming agent chat endpoint. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const proc = require('./proc');
const providers = require('./providers');
const { sendJSON, readJSON } = require('./httpx');
const { safeJoin, isAllowedCommand } = require('./security');
const { buildSystemPrompt, approxTokens, fitMessages, createAgentParser, createThinkFilter } = require('./agent');

const DEFAULT_MODEL = 'qwen3.6:35b-a3b-q4_K_M';

/**
 * POST /api/projects/:id/chat
 * Streams NDJSON agent events while writing files to disk as they complete:
 *   {type: thinking|token|fileStart|fileChunk|fileDone|deleted|error|done}
 */
async function handleChat(req, res, id) {
  const dir = store.projectDir(id);
  if (!dir) return sendJSON(res, 404, { error: 'project not found' });
  const body = await readJSON(req);
  const userMessage = String(body.message || '').trim();
  const model = String(body.model || DEFAULT_MODEL);
  const provider = String(body.provider || 'ollama');
  if (!userMessage) return sendJSON(res, 400, { error: 'empty message' });

  const meta = (await store.readMeta(dir)) || { name: id };
  const chat = await store.readChat(dir);
  const system = await buildSystemPrompt(dir, meta);
  const { messages, dropped } = fitMessages({
    system, chat, userMessage,
    numCtx: config.numCtx,
    reserve: config.ctxReserve,
  });
  if (dropped > 0) {
    log.debug('trimmed chat history to fit context', { project: id, dropped, kept: chat.length - dropped });
  }
  if (approxTokens(system) > config.numCtx - config.ctxReserve) {
    log.warn('system prompt alone may exceed the context window', {
      project: id,
      approxTokens: approxTokens(system),
      numCtx: config.numCtx,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch { /* client gone */ }
  };

  let narrationAll = '';
  const fileOps = [];
  const runsAll = [];
  let pendingRuns = [];
  const started = Date.now();
  const checkpoint = store.createCheckpoint(dir, userMessage);

  const parser = createAgentParser({
    narration(text) {
      narrationAll += text;
      emit({ type: 'token', text });
    },
    fileStart(p) {
      emit({ type: 'fileStart', path: p });
    },
    fileChunk(p, bytes, text) {
      emit({ type: 'fileChunk', path: p, bytes, text });
    },
    del(p) {
      const full = safeJoin(dir, p);
      if (full && fs.existsSync(full)) {
        try {
          checkpoint.record(p, full);
          fs.rmSync(full);
          fileOps.push({ op: 'delete', path: p });
          emit({ type: 'deleted', path: p });
        } catch (e) {
          emit({ type: 'error', message: `failed to delete ${p}: ${e.message}` });
        }
      }
    },
    fileDone(p, content, truncated) {
      const full = safeJoin(dir, p);
      if (!full) return emit({ type: 'error', message: `rejected unsafe path: ${p}` });
      try {
        checkpoint.record(p, full);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        fileOps.push({ op: 'write', path: p, bytes: content.length, truncated });
        emit({ type: 'fileDone', path: p, bytes: content.length, truncated });
      } catch (e) {
        emit({ type: 'error', message: `failed to write ${p}: ${e.message}` });
      }
    },
    run(command) {
      if (pendingRuns.length >= 3) {
        return emit({ type: 'error', message: 'too many RUN commands in one round, skipping: ' + command });
      }
      pendingRuns.push(command);
      emit({ type: 'run', command });
    },
  });

  let assistantRaw = '';  // raw content of the current model reply, for the next iteration
  const think = createThinkFilter({
    onThinking: (text) => emit({ type: 'thinking', text }),
    onContent: (text) => { assistantRaw += text; parser.feed(text); },
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const persist = async (interrupted) => {
    if (!narrationAll.trim() && !fileOps.length && !runsAll.length && interrupted) return;
    const manifest = checkpoint.commit();
    const opLines = fileOps.map((f) =>
      f.op === 'delete'
        ? `(deleted ${f.path})`
        : `(wrote ${f.path}, ${f.bytes} chars${f.truncated ? ', TRUNCATED — may need to be rewritten' : ''})`);
    opLines.push(...runsAll.map((r) => `(ran ${r.command} -> exit ${r.code})`));
    if (interrupted) opLines.push('(interrupted)');
    chat.push({ role: 'user', content: userMessage, at: Date.now() });
    const entry = { role: 'assistant', content: [narrationAll.trim(), ...opLines].filter(Boolean).join('\n'), at: Date.now() };
    if (manifest) entry.turn = manifest.id;
    chat.push(entry);
    await store.writeChat(dir, chat);
    meta.updatedAt = Date.now();
    meta.model = model;
    meta.provider = provider;
    await store.writeMeta(dir, meta);
    return manifest;
  };

  try {
    // The agent loop: stream a reply; if it requested RUN commands, execute
    // them, feed the output back, and let the model continue. Bounded by
    // config.agentMaxIters rounds per user message.
    for (let iter = 1; ; iter++) {
      assistantRaw = '';
      pendingRuns = [];
      for await (const j of providers.chatStream({ provider, model, messages, signal: ac.signal })) {
        if (j.message) {
          if (j.message.thinking) emit({ type: 'thinking', text: j.message.thinking });
          if (j.message.content) think.feed(j.message.content);
        }
        if (j.error) emit({ type: 'error', message: j.error });
      }
      think.flush();
      parser.finish();
      if (!pendingRuns.length || iter >= config.agentMaxIters) break;

      const results = [];
      for (const command of pendingRuns) {
        const result = isAllowedCommand(command)
          ? await execInProject(dir, command)
          : { ok: false, code: 1, timedOut: false, output: 'command not allowed: only node / python / npm, without shell metacharacters' };
        runsAll.push({ command, code: result.code });
        emit({ type: 'runResult', command, ok: result.ok, code: result.code, timedOut: result.timedOut, output: result.output.slice(0, 8000) });
        results.push({ command, result });
      }
      messages.push({ role: 'assistant', content: assistantRaw });
      messages.push({
        role: 'user',
        content: 'CONSOLE OUTPUT (your RUN commands were executed in the project folder):\n\n'
          + results.map(({ command, result }) =>
            `$ ${command}\n${result.output.trim() || '(no output)'}\n(exit ${result.code}${result.timedOut ? ', timed out' : ''})`).join('\n\n')
          + '\n\nContinue. Fix any errors by rewriting the affected files completely, or briefly confirm success to the user. Do not repeat a RUN unless a file changed.',
      });
      log.debug('agent run round', { project: id, iter, commands: pendingRuns.length });
    }
    const manifest = await persist(false);
    emit({ type: 'done', files: fileOps, runs: runsAll.length, turn: manifest ? manifest.id : null, ms: Date.now() - started });
    log.info('agent turn complete', { project: id, model, files: fileOps.length, runs: runsAll.length, ms: Date.now() - started });
  } catch (e) {
    if (e.name !== 'AbortError') {
      emit({ type: 'error', message: e.message });
      log.warn('agent turn failed', { project: id, error: e.message });
    }
    try {
      think.flush();
      parser.finish();
      await persist(true);
    } catch { /* best effort */ }
  }
  res.end();
}

/** Run an allowlisted command in the project dir; resolves with the result. */
function execInProject(dir, command) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: dir,
      timeout: config.execTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        timedOut: !!(err && err.killed),
        output: [stdout, stderr].filter(Boolean).join('\n').slice(0, config.execOutputCap),
      });
    });
  });
}

/** POST /api/projects/:id/exec — run an allowlisted command in the project dir. */
async function handleExec(res, dir, command) {
  if (!isAllowedCommand(command)) {
    return sendJSON(res, 400, { error: 'Only node / python / npm commands are allowed.' });
  }
  sendJSON(res, 200, await execInProject(dir, command));
}

/** Route an /api/* request. Returns true if handled. */
async function handleAPI(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    const h = await providers.health();
    return sendJSON(res, 200, { ok: true, ...h, ollamaHost: config.ollamaHost });
  }

  if (p === '/api/models' && req.method === 'GET') {
    try {
      return sendJSON(res, 200, { models: await providers.listModels() });
    } catch (e) {
      return sendJSON(res, 502, { error: 'no model provider reachable', detail: e.message });
    }
  }

  if (p === '/api/workspace' && req.method === 'GET') {
    return sendJSON(res, 200, await store.readWorkspace());
  }
  if (p === '/api/workspace' && req.method === 'PUT') {
    const body = await readJSON(req);
    return sendJSON(res, 200, await store.writeWorkspace(body));
  }

  if (p === '/api/projects' && req.method === 'GET') {
    return sendJSON(res, 200, { projects: await store.listProjects() });
  }

  if (p === '/api/projects' && req.method === 'POST') {
    const body = await readJSON(req);
    const meta = await store.createProject(body);
    log.info('project created', { id: meta.id });
    return sendJSON(res, 201, meta);
  }

  const m = p.match(/^\/api\/projects\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const id = m[1];
    const sub = m[2] || '';
    const dir = store.projectDir(id);
    if (!dir) return sendJSON(res, 404, { error: 'project not found' });

    if (sub === '' && req.method === 'DELETE') {
      await proc.stop(id);
      await store.deleteProject(id);
      log.info('project deleted', { id });
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === '' && req.method === 'PATCH') {
      const body = await readJSON(req);
      const meta = await store.readMeta(dir);
      if (body.name) meta.name = String(body.name).slice(0, 80);
      if (body.description !== undefined) meta.description = String(body.description).slice(0, 500);
      if (body.runCommand !== undefined) meta.runCommand = String(body.runCommand).slice(0, 200);
      if (body.published !== undefined) meta.published = !!body.published;
      meta.updatedAt = Date.now();
      await store.writeMeta(dir, meta);
      return sendJSON(res, 200, meta);
    }
    if (sub === '/run' && req.method === 'GET') {
      return sendJSON(res, 200, proc.status(id));
    }
    if (sub === '/run' && req.method === 'POST') {
      const body = await readJSON(req);
      const command = String(body.command || '').trim();
      if (!isAllowedCommand(command)) {
        return sendJSON(res, 400, { error: 'Only node / python / npm commands are allowed, without shell metacharacters.' });
      }
      const meta = await store.readMeta(dir);
      if (meta && meta.runCommand !== command) {
        meta.runCommand = command;
        await store.writeMeta(dir, meta);
      }
      return sendJSON(res, 200, { ok: true, ...(await proc.start(id, dir, command)) });
    }
    if (sub === '/stop' && req.method === 'POST') {
      await proc.stop(id);
      return sendJSON(res, 200, { ok: true, ...proc.status(id) });
    }
    if (sub === '/logs' && req.method === 'GET') {
      const after = parseInt(url.searchParams.get('after'), 10) || 0;
      return sendJSON(res, 200, proc.logs(id, after));
    }
    if (sub === '/files' && req.method === 'GET') {
      return sendJSON(res, 200, {
        files: await store.listFiles(dir),
        chat: await store.readChat(dir),
        meta: await store.readMeta(dir),
      });
    }
    if (sub === '/file') {
      const rel = url.searchParams.get('path');
      const full = rel && safeJoin(dir, rel);
      if (!full) return sendJSON(res, 400, { error: 'bad path' });
      if (req.method === 'GET') {
        try {
          return sendJSON(res, 200, { path: rel, content: await fsp.readFile(full, 'utf8') });
        } catch {
          return sendJSON(res, 404, { error: 'not found' });
        }
      }
      if (req.method === 'PUT') {
        const body = await readJSON(req);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, String(body.content ?? ''), 'utf8');
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        try { await fsp.rm(full); } catch { /* already gone */ }
        return sendJSON(res, 200, { ok: true });
      }
    }
    if (sub === '/checkpoints' && req.method === 'GET') {
      return sendJSON(res, 200, { checkpoints: await store.listCheckpoints(dir) });
    }
    if (sub === '/rollback' && req.method === 'POST') {
      const body = await readJSON(req);
      const turn = String(body.turn || '');
      const undoneIds = await store.rollbackTo(dir, turn);
      if (undoneIds === null) return sendJSON(res, 404, { error: 'no such checkpoint' });
      const undone = undoneIds.length;
      const chat = await store.readChat(dir);
      const idx = chat.findIndex((m) => m.turn === turn);
      const req0 = idx > 0 && chat[idx - 1].role === 'user' ? chat[idx - 1].content : '';
      const label = req0 ? ` before the request ${JSON.stringify(req0.split('\n')[0].slice(0, 80))}` : '';
      // consumed checkpoints can no longer be restored; unlink them from chat
      for (const m of chat) {
        if (m.turn && undoneIds.includes(m.turn)) delete m.turn;
      }
      chat.push({
        role: 'assistant',
        content: `(project files rolled back${label}, ${undone} turn${undone === 1 ? '' : 's'} undone. The system prompt shows the current files.)`,
        at: Date.now(),
      });
      await store.writeChat(dir, chat);
      const meta = await store.readMeta(dir);
      if (meta) {
        meta.updatedAt = Date.now();
        await store.writeMeta(dir, meta);
      }
      log.info('checkpoint restored', { project: id, turn, undone });
      return sendJSON(res, 200, { ok: true, undone });
    }
    if (sub === '/chat' && req.method === 'POST') return handleChat(req, res, id);
    if (sub === '/exec' && req.method === 'POST') {
      const body = await readJSON(req);
      return handleExec(res, dir, String(body.command || '').trim());
    }
  }

  return sendJSON(res, 404, { error: 'no such route' });
}

module.exports = { handleAPI };
