/**
 * Replica — a local Replit-style workspace powered by Ollama.
 * Zero npm dependencies. Node 18+ required (uses built-in fetch).
 *
 *   node server.js          → http://localhost:4747
 *
 * Routes:
 *   /                        marketing page
 *   /agent                   workspace app
 *   /preview/:id/*           static preview of a project
 *   /api/*                   JSON API (projects, files, chat stream, exec)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT || 4747);
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS = path.join(ROOT, 'projects');

fs.mkdirSync(PROJECTS, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const TEXT_EXT = new Set([
  '.html', '.css', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.py',
  '.svg', '.ts', '.tsx', '.jsx', '.xml', '.yml', '.yaml', '.toml', '.sql',
  '.sh', '.bat', '.ps1', '.env', '.gitignore', '.csv',
]);

// ---------------------------------------------------------------- helpers

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

/** Join a user-supplied relative path under base; reject traversal. */
function safeJoin(base, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(base, clean);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function projectDir(id) {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) return null;
  const dir = path.join(PROJECTS, id);
  return fs.existsSync(dir) ? dir : null;
}

async function readMeta(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, '.replica', 'meta.json'), 'utf8')); }
  catch { return null; }
}
async function writeMeta(dir, meta) {
  await fsp.mkdir(path.join(dir, '.replica'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.replica', 'meta.json'), JSON.stringify(meta, null, 2));
}
async function readChat(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, '.replica', 'chat.json'), 'utf8')); }
  catch { return []; }
}
async function writeChat(dir, chat) {
  await fsp.mkdir(path.join(dir, '.replica'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.replica', 'chat.json'), JSON.stringify(chat, null, 2));
}

/** Recursive file listing, skipping internals. Returns [{path, size}]. */
async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.replica' || e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await listFiles(full, base));
    } else {
      const st = await fsp.stat(full);
      out.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: st.size });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (s || 'project') + '-' + crypto.randomBytes(2).toString('hex');
}

// ------------------------------------------------------------ agent brain

const PROTOCOL_PROMPT = `You are Replica Agent, an autonomous senior software engineer inside Replica, a fully local Replit-style workspace. You build and modify real projects by writing complete files, which are saved to disk as you stream them.

STRICT OUTPUT PROTOCOL
- To create or overwrite a file, output exactly this block:
<<<FILE: relative/path.ext>>>
(the complete file contents)
<<<END FILE>>>
- To delete a file, output on its own line: <<<DELETE: relative/path.ext>>>
- NEVER wrap these blocks in markdown code fences. No \`\`\` anywhere.
- Always write the COMPLETE contents of every file. Never use placeholders, ellipses, or comments like "rest unchanged".
- Outside file blocks, speak to the user briefly: 1-3 sentences of plan before the first file, and 1-2 sentences of summary after the last one. No headings, no bullet lists of the code you already wrote.

ENGINEERING RULES
- Default stack is a static web app: index.html + style.css + script.js in vanilla JS. The project is previewed in an iframe served from the project root, and index.html is the entry point.
- Use relative asset paths ("style.css", not "/style.css").
- Zero external network dependencies: no CDNs, no Google Fonts, no external images. Use system font stacks, inline SVG, CSS gradients, and emoji.
- Make the result genuinely polished: real layout, spacing, hover/focus states, sensible color palette, empty states, and responsive behavior.
- Persist user data with localStorage where it makes sense.
- If the user asks for Python or Node scripts, write them; the user runs them in the Console tab with "python file.py" or "node file.js".
- When modifying an existing project, rewrite only the files that change, but each rewritten file must be complete.`;

const CONTEXT_FILE_CAP = 24_000;   // chars per file shown to the model
const CONTEXT_TOTAL_CAP = 90_000;  // total chars of file context

async function buildSystemPrompt(dir, meta) {
  const files = await listFiles(dir);
  let ctx = '';
  let total = 0;
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    if (!TEXT_EXT.has(ext) && !f.path.includes('.')) continue;
    if (!TEXT_EXT.has(ext)) { ctx += `\n--- ${f.path} (binary, ${f.size} bytes) ---\n`; continue; }
    let body = '';
    try { body = await fsp.readFile(path.join(dir, f.path), 'utf8'); } catch { continue; }
    if (body.length > CONTEXT_FILE_CAP) body = body.slice(0, CONTEXT_FILE_CAP) + `\n…(truncated, ${body.length} chars total)`;
    if (total + body.length > CONTEXT_TOTAL_CAP) { ctx += `\n--- ${f.path} (omitted for length) ---\n`; continue; }
    total += body.length;
    ctx += `\n--- ${f.path} ---\n${body}\n`;
  }
  const fileSection = files.length
    ? `CURRENT PROJECT FILES (source of truth):\n${ctx}`
    : 'The project is currently EMPTY. Create it from scratch.';
  return `${PROTOCOL_PROMPT}\n\nPROJECT: ${meta.name}\n${meta.description ? 'BRIEF: ' + meta.description + '\n' : ''}\n${fileSection}`;
}

/**
 * Streaming parser for the agent protocol. Feeds narration/thinking/file
 * events as the model streams, holding back partial markers at chunk edges.
 */
function createAgentParser(ev) {
  const FILE_RE = /<<<FILE:\s*([^>\n]+?)\s*>>>[ \t]*\r?\n?/;
  const DEL_RE = /<<<DELETE:\s*([^>\n]+?)\s*>>>/;
  const END_MARK = '<<<END FILE>>>';
  let buf = '';
  let inFile = false;
  let filePath = '';
  let fileBuf = '';

  function pump() {
    for (;;) {
      if (!inFile) {
        const m = buf.match(FILE_RE);
        const d = buf.match(DEL_RE);
        if (m && (!d || m.index <= d.index)) {
          if (m.index > 0) ev.narration(buf.slice(0, m.index));
          buf = buf.slice(m.index + m[0].length);
          filePath = m[1].trim();
          fileBuf = '';
          inFile = true;
          ev.fileStart(filePath);
          continue;
        }
        if (d) {
          if (d.index > 0) ev.narration(buf.slice(0, d.index));
          buf = buf.slice(d.index + d[0].length);
          ev.del(d[1].trim());
          continue;
        }
        // hold back a tail that could be the start of a marker
        const hold = 48;
        if (buf.length > hold) {
          ev.narration(buf.slice(0, buf.length - hold));
          buf = buf.slice(buf.length - hold);
        }
        return;
      }
      const end = buf.indexOf(END_MARK);
      if (end !== -1) {
        fileBuf += buf.slice(0, end);
        buf = buf.slice(end + END_MARK.length);
        let content = fileBuf.replace(/\r?\n$/, '');
        // defensive: strip accidental markdown fences around the whole file
        content = content.replace(/^```[a-z]*\r?\n/i, '').replace(/\r?\n```\s*$/, '');
        inFile = false;
        ev.fileDone(filePath, content, false);
        filePath = ''; fileBuf = '';
        continue;
      }
      const hold = END_MARK.length + 8;
      if (buf.length > hold) {
        fileBuf += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        ev.fileChunk(filePath, fileBuf.length);
      }
      return;
    }
  }

  return {
    feed(text) { buf += text; pump(); },
    finish() {
      if (inFile) {
        // stream was cut off mid-file — save what we have, flagged truncated
        let content = (fileBuf + buf).replace(/^```[a-z]*\r?\n/i, '');
        ev.fileDone(filePath, content, true);
      } else if (buf.trim()) {
        ev.narration(buf);
      }
      buf = ''; inFile = false;
    },
  };
}

/** POST /api/projects/:id/chat — NDJSON stream of agent events. */
async function handleChat(req, res, id) {
  const dir = projectDir(id);
  if (!dir) return sendJSON(res, 404, { error: 'project not found' });
  const body = await readJSON(req);
  const userMessage = String(body.message || '').trim();
  const model = String(body.model || 'qwen3.6:35b-a3b-q4_K_M');
  if (!userMessage) return sendJSON(res, 400, { error: 'empty message' });

  const meta = await readMeta(dir) || { name: id };
  const chat = await readChat(dir);
  const system = await buildSystemPrompt(dir, meta);
  const messages = [
    { role: 'system', content: system },
    ...chat.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  let narrationAll = '';
  const fileOps = [];
  const started = Date.now();

  const parser = createAgentParser({
    narration(text) { narrationAll += text; emit({ type: 'token', text }); },
    fileStart(p) { emit({ type: 'fileStart', path: p }); },
    fileChunk(p, bytes) { emit({ type: 'fileChunk', path: p, bytes }); },
    del(p) {
      const full = safeJoin(dir, p);
      if (full && fs.existsSync(full)) {
        try { fs.rmSync(full); fileOps.push({ op: 'delete', path: p }); emit({ type: 'deleted', path: p }); } catch {}
      }
    },
    fileDone(p, content, truncated) {
      const full = safeJoin(dir, p);
      if (!full) return emit({ type: 'error', message: `rejected unsafe path: ${p}` });
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        fileOps.push({ op: 'write', path: p, bytes: content.length, truncated });
        emit({ type: 'fileDone', path: p, bytes: content.length, truncated });
      } catch (e) {
        emit({ type: 'error', message: `failed to write ${p}: ${e.message}` });
      }
    },
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  // strip <think>…</think> if the model inlines it instead of using the
  // dedicated thinking channel
  let inThink = false;
  let tagBuf = '';
  function feedContent(text) {
    tagBuf += text;
    for (;;) {
      if (inThink) {
        const close = tagBuf.indexOf('</think>');
        if (close === -1) {
          if (tagBuf.length > 9) { emit({ type: 'thinking', text: tagBuf.slice(0, -9) }); tagBuf = tagBuf.slice(-9); }
          return;
        }
        emit({ type: 'thinking', text: tagBuf.slice(0, close) });
        tagBuf = tagBuf.slice(close + 8);
        inThink = false;
      } else {
        const open = tagBuf.indexOf('<think>');
        if (open === -1) {
          if (tagBuf.length > 8) { parser.feed(tagBuf.slice(0, -8)); tagBuf = tagBuf.slice(-8); }
          return;
        }
        if (open > 0) parser.feed(tagBuf.slice(0, open));
        tagBuf = tagBuf.slice(open + 7);
        inThink = true;
      }
    }
  }
  function flushContent() {
    if (!inThink && tagBuf) parser.feed(tagBuf);
    tagBuf = '';
    parser.finish();
  }

  try {
    const upstream = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '20m',
        options: { temperature: 0.4, num_ctx: 32768 },
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      emit({ type: 'error', message: `Ollama ${upstream.status}: ${errText.slice(0, 400)}` });
      return res.end();
    }
    let lineBuf = '';
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      lineBuf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.message) {
          if (j.message.thinking) emit({ type: 'thinking', text: j.message.thinking });
          if (j.message.content) feedContent(j.message.content);
        }
        if (j.error) emit({ type: 'error', message: j.error });
      }
    }
    flushContent();

    // persist compacted history: full narration + a record of file ops
    const opLines = fileOps.map((f) =>
      f.op === 'delete' ? `(deleted ${f.path})` : `(wrote ${f.path}, ${f.bytes} chars${f.truncated ? ', TRUNCATED — may need to be rewritten' : ''})`);
    chat.push({ role: 'user', content: userMessage, at: Date.now() });
    chat.push({ role: 'assistant', content: [narrationAll.trim(), ...opLines].filter(Boolean).join('\n'), at: Date.now() });
    await writeChat(dir, chat);
    meta.updatedAt = Date.now();
    meta.model = model;
    await writeMeta(dir, meta);

    emit({ type: 'done', files: fileOps, ms: Date.now() - started });
  } catch (e) {
    if (e.name !== 'AbortError') emit({ type: 'error', message: e.message });
    // still persist whatever happened before the abort/failure
    try {
      flushContent();
      if (narrationAll.trim() || fileOps.length) {
        const opLines = fileOps.map((f) => `(wrote ${f.path})`);
        chat.push({ role: 'user', content: userMessage, at: Date.now() });
        chat.push({ role: 'assistant', content: [narrationAll.trim(), ...opLines, '(interrupted)'].filter(Boolean).join('\n'), at: Date.now() });
        await writeChat(dir, chat);
      }
    } catch {}
  }
  res.end();
}

// ------------------------------------------------------------------- API

async function handleAPI(req, res, url) {
  const p = url.pathname;

  // GET /api/health
  if (p === '/api/health') {
    let ollama = false;
    try { ollama = (await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2500) })).ok; } catch {}
    return sendJSON(res, 200, { ok: true, ollama, ollamaHost: OLLAMA });
  }

  // GET /api/models — chat-capable models from Ollama
  if (p === '/api/models' && req.method === 'GET') {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      const models = (j.models || [])
        .filter((m) => {
          if (m.capabilities) return m.capabilities.includes('completion');
          return !/embed|bge|minilm/i.test(m.name);
        })
        .map((m) => ({
          name: m.name,
          size: m.size,
          family: m.details?.family || '',
          params: m.details?.parameter_size || '',
        }));
      return sendJSON(res, 200, { models });
    } catch (e) {
      return sendJSON(res, 502, { error: 'Ollama unreachable at ' + OLLAMA, detail: e.message });
    }
  }

  // GET /api/projects
  if (p === '/api/projects' && req.method === 'GET') {
    const out = [];
    for (const name of await fsp.readdir(PROJECTS).catch(() => [])) {
      const dir = path.join(PROJECTS, name);
      if (!(await fsp.stat(dir)).isDirectory()) continue;
      const meta = await readMeta(dir);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sendJSON(res, 200, { projects: out });
  }

  // POST /api/projects {name, description, files?}
  if (p === '/api/projects' && req.method === 'POST') {
    const body = await readJSON(req);
    const name = String(body.name || 'Untitled project').slice(0, 80);
    const id = slugify(name);
    const dir = path.join(PROJECTS, id);
    await fsp.mkdir(dir, { recursive: true });
    const meta = {
      id, name,
      description: String(body.description || '').slice(0, 500),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await writeMeta(dir, meta);
    await writeChat(dir, []);
    if (Array.isArray(body.files)) {
      for (const f of body.files.slice(0, 200)) {
        const full = safeJoin(dir, f.path);
        if (!full) continue;
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, String(f.content ?? ''), 'utf8');
      }
    }
    return sendJSON(res, 201, meta);
  }

  // routes with :id
  let m = p.match(/^\/api\/projects\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const id = m[1];
    const sub = m[2] || '';
    const dir = projectDir(id);
    if (!dir) return sendJSON(res, 404, { error: 'project not found' });

    if (sub === '' && req.method === 'DELETE') {
      await fsp.rm(dir, { recursive: true, force: true });
      return sendJSON(res, 200, { ok: true });
    }
    if (sub === '' && req.method === 'PATCH') {
      const body = await readJSON(req);
      const meta = await readMeta(dir);
      if (body.name) meta.name = String(body.name).slice(0, 80);
      if (body.description !== undefined) meta.description = String(body.description).slice(0, 500);
      meta.updatedAt = Date.now();
      await writeMeta(dir, meta);
      return sendJSON(res, 200, meta);
    }
    if (sub === '/files' && req.method === 'GET') {
      return sendJSON(res, 200, { files: await listFiles(dir), chat: await readChat(dir), meta: await readMeta(dir) });
    }
    if (sub === '/file') {
      const rel = url.searchParams.get('path');
      const full = rel && safeJoin(dir, rel);
      if (!full) return sendJSON(res, 400, { error: 'bad path' });
      if (req.method === 'GET') {
        try { return sendJSON(res, 200, { path: rel, content: await fsp.readFile(full, 'utf8') }); }
        catch { return sendJSON(res, 404, { error: 'not found' }); }
      }
      if (req.method === 'PUT') {
        const body = await readJSON(req);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, String(body.content ?? ''), 'utf8');
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        try { await fsp.rm(full); } catch {}
        return sendJSON(res, 200, { ok: true });
      }
    }
    if (sub === '/chat' && req.method === 'POST') return handleChat(req, res, id);
    if (sub === '/exec' && req.method === 'POST') {
      const body = await readJSON(req);
      const cmd = String(body.command || '').trim();
      if (!/^(node|python|py|pip|npm|npx)\b/.test(cmd)) {
        return sendJSON(res, 400, { error: 'Only node / python / npm commands are allowed.' });
      }
      return exec(cmd, { cwd: dir, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        sendJSON(res, 200, {
          ok: !err,
          code: err ? (err.code ?? 1) : 0,
          timedOut: !!(err && err.killed),
          output: [stdout, stderr].filter(Boolean).join('\n').slice(0, 200_000),
        });
      });
    }
  }
  return sendJSON(res, 404, { error: 'no such route' });
}

// ---------------------------------------------------------------- server

async function serveFile(res, full, extraHeaders = {}) {
  try {
    const data = await fsp.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, ...extraHeaders });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) return await handleAPI(req, res, url);

    // project preview — served with no-cache so edits show up on refresh
    const pm = p.match(/^\/preview\/([a-z0-9-]+)(\/.*)?$/);
    if (pm) {
      const dir = projectDir(pm[1]);
      if (!dir) return send(res, 404, 'Project not found');
      let rel = (pm[2] || '/').replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      let full = safeJoin(dir, rel);
      if (!full) return send(res, 400, 'Bad path');
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
      if (!fs.existsSync(full)) {
        return send(res, 404, `<!doctype html><meta charset="utf-8"><body style="background:#0E1525;color:#9DA2A6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:40px">🛠️</div><p>No index.html in this project yet.<br>Ask the Agent to build something.</p></div>`, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      return await serveFile(res, full, { 'Cache-Control': 'no-store' });
    }

    if (p === '/' || p === '/index.html') return await serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/agent' || p === '/agent/') return await serveFile(res, path.join(PUBLIC, 'agent.html'));
    const full = safeJoin(PUBLIC, p);
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) return await serveFile(res, full);
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  Replica running:`);
  console.log(`  ➜  Marketing page:  http://localhost:${PORT}/`);
  console.log(`  ➜  Agent workspace: http://localhost:${PORT}/agent`);
  console.log(`  ➜  Ollama backend:  ${OLLAMA}\n`);
});
