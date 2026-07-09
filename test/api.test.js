'use strict';

/**
 * Integration test: boots the full app on an ephemeral port with a mocked
 * Ollama backend, then drives the real HTTP API end to end — project CRUD,
 * a streamed agent chat turn that writes files to disk, file editing, and
 * the preview server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base;          // http://127.0.0.1:<port>
let app;
let mock;
let projectsDir;

/** Mocked Ollama: /api/tags, /api/version, and a scripted /api/chat stream. */
function startMockOllama() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"version":"0.0.0-mock"}');
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          models: [
            { name: 'mock-coder:1b', size: 1, details: { family: 'mock', parameter_size: '1B' }, capabilities: ['completion'] },
            { name: 'mock-embed:1b', size: 1, details: { family: 'bert' }, capabilities: ['embedding'] },
          ],
        }));
      }
      if (req.url === '/api/chat') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          let lastUser = '';
          try {
            const msgs = JSON.parse(raw).messages || [];
            lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
          } catch { /* default script */ }
          let chunks;
          if (/^CONSOLE OUTPUT/.test(lastUser)) {
            // second round of the RUN loop: the mock reads its own output back
            chunks = [
              { message: { role: 'assistant', content: /42/.test(lastUser) ? 'Verified: the check printed 42.' : 'The check output was unexpected.' } },
              { done: true },
            ];
          } else if (/verify/i.test(lastUser)) {
            chunks = [
              { message: { role: 'assistant', content: 'Writing a check, then running it.\n<<<FILE: check.js>>>\nconsole.log(6*7);\n<<<END FILE>>>\n' } },
              { message: { role: 'assistant', content: '<<<RUN: node check.js>>>\n' } },
              { done: true },
            ];
          } else {
            chunks = [
              { message: { role: 'assistant', thinking: 'planning the page…' } },
              { message: { role: 'assistant', content: 'Building a tiny page.\n<<<FILE: index.html>>>\n<!doctype html>\n<h1>' } },
              { message: { role: 'assistant', content: 'Mock</h1>\n<<<END FILE>>>\n' } },
              { message: { role: 'assistant', content: '<<<FILE: style.css>>>\nh1 { color: teal; }\n<<<END FILE>>>\nDone.' } },
              { done: true },
            ];
          }
          let i = 0;
          const t = setInterval(() => {
            if (i >= chunks.length) { clearInterval(t); return res.end(); }
            res.write(JSON.stringify(chunks[i++]) + '\n');
          }, 5);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function json(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  mock = await startMockOllama();
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-test-'));
  process.env.OLLAMA_HOST = `http://127.0.0.1:${mock.address().port}`;
  process.env.REPLICA_PROJECTS_DIR = projectsDir;
  process.env.REPLICA_LOG_LEVEL = 'error';

  // config reads the environment at require time, so import only now
  const { createApp } = require('../lib/app');
  app = createApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  await require('../lib/proc').stopAll();
  app?.close();
  mock?.close();
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

test('health reports the mocked ollama as up', async () => {
  const { status, body } = await json('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.ollama, true);
});

test('models endpoint filters out embedding models', async () => {
  const { status, body } = await json('GET', '/api/models');
  assert.equal(status, 200);
  assert.deepEqual(body.models.map((m) => m.name), ['mock-coder:1b']);
});

test('full agent turn: create project, stream chat, files land on disk', async () => {
  const created = await json('POST', '/api/projects', { name: 'Mock App', description: 'test brief' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.match(id, /^mock-app-[0-9a-f]{4}$/);

  // stream a chat turn
  const r = await fetch(`${base}/api/projects/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'build it', model: 'mock-coder:1b' }),
  });
  assert.equal(r.status, 200);
  const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));

  const types = events.map((e) => e.type);
  assert.ok(types.includes('thinking'), 'streams thinking');
  assert.ok(types.includes('token'), 'streams narration');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, 'emits done');
  assert.deepEqual(done.files.map((f) => f.path), ['index.html', 'style.css']);

  // files really exist with the streamed contents
  const idx = fs.readFileSync(path.join(projectsDir, id, 'index.html'), 'utf8');
  assert.equal(idx, '<!doctype html>\n<h1>Mock</h1>');
  const css = fs.readFileSync(path.join(projectsDir, id, 'style.css'), 'utf8');
  assert.equal(css, 'h1 { color: teal; }');

  // history was compacted and persisted
  const files = await json('GET', `/api/projects/${id}/files`);
  assert.equal(files.body.chat.length, 2);
  assert.equal(files.body.chat[0].role, 'user');
  assert.match(files.body.chat[1].content, /\(wrote index\.html, \d+ chars\)/);

  // preview serves the generated app
  const prev = await fetch(`${base}/preview/${id}/`);
  assert.equal(prev.status, 200);
  assert.match(await prev.text(), /<h1>Mock<\/h1>/);
  assert.equal(prev.headers.get('cache-control'), 'no-store');
});

test('file editing round-trip and traversal rejection', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Edit Me' });
  const put = await json('PUT', `/api/projects/${meta.id}/file?path=notes.md`, { content: 'hello' });
  assert.equal(put.status, 200);
  const got = await json('GET', `/api/projects/${meta.id}/file?path=notes.md`);
  assert.equal(got.body.content, 'hello');

  const evil = await json('PUT', `/api/projects/${meta.id}/file?path=../escape.txt`, { content: 'nope' });
  assert.equal(evil.status, 400);
  assert.ok(!fs.existsSync(path.join(projectsDir, 'escape.txt')));

  const del = await json('DELETE', `/api/projects/${meta.id}/file?path=notes.md`);
  assert.equal(del.status, 200);
});

async function runChatTurn(id, message = 'build it') {
  const r = await fetch(`${base}/api/projects/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, model: 'mock-coder:1b' }),
  });
  assert.equal(r.status, 200);
  return (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
}

test('agent RUN loop executes the command and feeds output back', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Verifier' });
  const events = await runChatTurn(meta.id, 'please verify your work');

  const run = events.find((e) => e.type === 'run');
  assert.ok(run, 'streams the run request');
  assert.equal(run.command, 'node check.js');

  const result = events.find((e) => e.type === 'runResult');
  assert.ok(result, 'streams the run result');
  assert.equal(result.code, 0);
  assert.match(result.output, /42/);

  // the second model round saw the output and narrated it
  const narration = events.filter((e) => e.type === 'token').map((e) => e.text).join('');
  assert.match(narration, /Verified: the check printed 42/);

  // compacted history records the run
  const files = await json('GET', `/api/projects/${meta.id}/files`);
  assert.match(files.body.chat.at(-1).content, /\(ran node check\.js -> exit 0\)/);
});

test('preview HTML gets the error bridge injected', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Bridged' });
  await json('PUT', `/api/projects/${meta.id}/file?path=index.html`, {
    content: '<!doctype html><html><body><h1>Hi</h1></body></html>',
  });
  const prev = await fetch(`${base}/preview/${meta.id}/`);
  const html = await prev.text();
  assert.match(html, /<script src="\/replica-bridge\.js"><\/script><\/body>/);
  // the bridge itself is served
  const bridge = await fetch(`${base}/replica-bridge.js`);
  assert.equal(bridge.status, 200);
  assert.match(await bridge.text(), /preview-error/);
});

test('checkpoints capture pre-turn state and rollback restores it', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Checkpointed' });
  await json('PUT', `/api/projects/${meta.id}/file?path=index.html`, { content: 'ORIGINAL' });

  const events = await runChatTurn(meta.id);
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.turn, 'done event carries the checkpoint id');

  // the turn overwrote index.html and created style.css
  assert.equal(fs.readFileSync(path.join(projectsDir, meta.id, 'index.html'), 'utf8'), '<!doctype html>\n<h1>Mock</h1>');
  assert.ok(fs.existsSync(path.join(projectsDir, meta.id, 'style.css')));

  const cps = await json('GET', `/api/projects/${meta.id}/checkpoints`);
  assert.equal(cps.body.checkpoints.length, 1);
  assert.equal(cps.body.checkpoints[0].id, done.turn);
  assert.equal(cps.body.checkpoints[0].files, 2);

  const rb = await json('POST', `/api/projects/${meta.id}/rollback`, { turn: done.turn });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.undone, 1);

  // pre-turn state is back: original content restored, new file gone
  assert.equal(fs.readFileSync(path.join(projectsDir, meta.id, 'index.html'), 'utf8'), 'ORIGINAL');
  assert.ok(!fs.existsSync(path.join(projectsDir, meta.id, 'style.css')));

  // the checkpoint is consumed, the chat records the rollback
  const after = await json('GET', `/api/projects/${meta.id}/checkpoints`);
  assert.equal(after.body.checkpoints.length, 0);
  const files = await json('GET', `/api/projects/${meta.id}/files`);
  assert.match(files.body.chat.at(-1).content, /rolled back/);
  assert.ok(!files.body.chat.some((m) => m.turn), 'stale checkpoint links removed');
});

test('rollback across multiple turns unwinds newest first', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Multi Turn' });
  const first = (await runChatTurn(meta.id)).find((e) => e.type === 'done');
  await json('PUT', `/api/projects/${meta.id}/file?path=index.html`, { content: 'EDITED BETWEEN TURNS' });
  const second = (await runChatTurn(meta.id)).find((e) => e.type === 'done');
  assert.ok(first.turn && second.turn && first.turn !== second.turn);

  // restoring the first checkpoint undoes both turns: back to the empty project
  const rb = await json('POST', `/api/projects/${meta.id}/rollback`, { turn: first.turn });
  assert.equal(rb.body.undone, 2);
  assert.ok(!fs.existsSync(path.join(projectsDir, meta.id, 'index.html')));
  assert.ok(!fs.existsSync(path.join(projectsDir, meta.id, 'style.css')));
});

test('rollback of an unknown checkpoint returns 404', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'No Checkpoint' });
  const rb = await json('POST', `/api/projects/${meta.id}/rollback`, { turn: 'nope-0000' });
  assert.equal(rb.status, 404);
});

test('exec runs allowlisted commands and rejects everything else', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Runner' });

  const ok = await json('POST', `/api/projects/${meta.id}/exec`, { command: 'node -e "console.log(6*7)"' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.match(ok.body.output, /42/);

  const bad = await json('POST', `/api/projects/${meta.id}/exec`, { command: 'curl http://example.com' });
  assert.equal(bad.status, 400);
});

test('run starts a server process, preview proxies to it, stop kills it', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Served App' });
  const server =
    "const http = require('http');\n" +
    "http.createServer((req, res) => {\n" +
    "  res.writeHead(200, { 'Content-Type': 'text/plain' });\n" +
    "  res.end('proc says hi from ' + req.url);\n" +
    "}).listen(process.env.PORT, '127.0.0.1');\n";
  await json('PUT', `/api/projects/${meta.id}/file?path=srv.js`, { content: server });

  const bad = await json('POST', `/api/projects/${meta.id}/run`, { command: 'curl http://example.com' });
  assert.equal(bad.status, 400);

  const started = await json('POST', `/api/projects/${meta.id}/run`, { command: 'node srv.js' });
  assert.equal(started.status, 200);
  assert.ok(started.body.running);
  assert.ok(started.body.port > 0);

  // wait for the port probe to mark the process proxy-ready
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    up = (await json('GET', `/api/projects/${meta.id}/run`)).body.up;
  }
  assert.ok(up, 'process becomes proxy-ready');

  // the preview now proxies to the running server instead of serving files
  const prev = await fetch(`${base}/preview/${meta.id}/some/path`);
  assert.equal(prev.status, 200);
  assert.match(await prev.text(), /proc says hi from \/some\/path/);

  // the run command is remembered on the project
  const files = await json('GET', `/api/projects/${meta.id}/files`);
  assert.equal(files.body.meta.runCommand, 'node srv.js');

  // logs are readable incrementally
  const logs = await json('GET', `/api/projects/${meta.id}/logs?after=0`);
  assert.ok(logs.body.lines.some((l) => /PORT=/.test(l.text)));

  const stopped = await json('POST', `/api/projects/${meta.id}/stop`);
  assert.equal(stopped.status, 200);
  let running = true;
  for (let i = 0; i < 50 && running; i++) {
    await new Promise((r) => setTimeout(r, 100));
    running = (await json('GET', `/api/projects/${meta.id}/run`)).body.running;
  }
  assert.ok(!running, 'process is gone after stop');

  // preview falls back to static serving
  const staticPrev = await fetch(`${base}/preview/${meta.id}/srv.js`);
  assert.match(await staticPrev.text(), /createServer/);
});

test('project deletion removes the directory', async () => {
  const { body: meta } = await json('POST', '/api/projects', { name: 'Doomed' });
  assert.ok(fs.existsSync(path.join(projectsDir, meta.id)));
  const del = await json('DELETE', `/api/projects/${meta.id}`);
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(path.join(projectsDir, meta.id)));
});

test('unknown API routes return JSON 404', async () => {
  const r = await json('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.ok(r.body.error);
});
