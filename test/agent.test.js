'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentParser, createThinkFilter, fitMessages } = require('../lib/agent');

/** Collect parser events into arrays for assertion. */
function collector() {
  const ev = { narration: [], files: [], deletes: [], starts: [], runs: [] };
  const parser = createAgentParser({
    narration: (t) => ev.narration.push(t),
    fileStart: (p) => ev.starts.push(p),
    fileChunk: () => {},
    fileDone: (p, content, truncated) => ev.files.push({ path: p, content, truncated }),
    del: (p) => ev.deletes.push(p),
    run: (c) => ev.runs.push(c),
  });
  return { ev, parser, narrationText: () => ev.narration.join('') };
}

const SAMPLE =
  'Plan: build the thing.\n' +
  '<<<FILE: index.html>>>\n' +
  '<!doctype html>\n<h1>Hi</h1>\n' +
  '<<<END FILE>>>\n' +
  'Now the styles.\n' +
  '<<<FILE: css/style.css>>>\n' +
  'body { color: red; }\n' +
  '<<<END FILE>>>\n' +
  '<<<DELETE: old.txt>>>\n' +
  'All done.';

test('parses file blocks, deletes, and narration from a single feed', () => {
  const { ev, parser, narrationText } = collector();
  parser.feed(SAMPLE);
  parser.finish();

  assert.equal(ev.files.length, 2);
  assert.deepEqual(ev.starts, ['index.html', 'css/style.css']);
  assert.equal(ev.files[0].path, 'index.html');
  assert.equal(ev.files[0].content, '<!doctype html>\n<h1>Hi</h1>');
  assert.equal(ev.files[0].truncated, false);
  assert.equal(ev.files[1].path, 'css/style.css');
  assert.equal(ev.files[1].content, 'body { color: red; }');
  assert.deepEqual(ev.deletes, ['old.txt']);
  const narr = narrationText();
  assert.match(narr, /Plan: build the thing\./);
  assert.match(narr, /Now the styles\./);
  assert.match(narr, /All done\./);
  assert.doesNotMatch(narr, /<<<|doctype/);
});

test('parses identically when fed one character at a time', () => {
  const { ev, parser, narrationText } = collector();
  for (const ch of SAMPLE) parser.feed(ch);
  parser.finish();

  assert.equal(ev.files.length, 2);
  assert.equal(ev.files[0].content, '<!doctype html>\n<h1>Hi</h1>');
  assert.equal(ev.files[1].content, 'body { color: red; }');
  assert.deepEqual(ev.deletes, ['old.txt']);
  assert.doesNotMatch(narrationText(), /<<<|END FILE/);
});

test('parses identically across random chunk sizes', () => {
  for (const size of [2, 3, 5, 7, 11, 17]) {
    const { ev, parser } = collector();
    for (let i = 0; i < SAMPLE.length; i += size) parser.feed(SAMPLE.slice(i, i + size));
    parser.finish();
    assert.equal(ev.files.length, 2, `chunk size ${size}`);
    assert.equal(ev.files[0].content, '<!doctype html>\n<h1>Hi</h1>', `chunk size ${size}`);
  }
});

test('flags a file cut off mid-stream as truncated', () => {
  const { ev, parser } = collector();
  parser.feed('Building.\n<<<FILE: app.js>>>\nconsole.log(1);\nconsole.log(2);');
  parser.finish();
  assert.equal(ev.files.length, 1);
  assert.equal(ev.files[0].truncated, true);
  assert.match(ev.files[0].content, /console\.log\(2\);/);
});

test('strips accidental markdown fences around file contents', () => {
  const { ev, parser } = collector();
  parser.feed('<<<FILE: a.js>>>\n```js\nlet x = 1;\n```\n<<<END FILE>>>');
  parser.finish();
  assert.equal(ev.files[0].content, 'let x = 1;');
});

test('file content containing angle brackets and partial markers survives', () => {
  const body = 'if (a <<< b) {}\nconst s = "<<<FILE: not-a-marker";\n<div>ok</div>';
  const { ev, parser } = collector();
  parser.feed(`<<<FILE: tricky.js>>>\n${body}\n<<<END FILE>>>\ndone`);
  parser.finish();
  assert.equal(ev.files.length, 1);
  assert.equal(ev.files[0].content, body);
});

test('parses RUN markers between files and narration', () => {
  const { ev, parser, narrationText } = collector();
  const src =
    'Writing a check.\n' +
    '<<<FILE: check.js>>>\nconsole.log(6*7);\n<<<END FILE>>>\n' +
    '<<<RUN: node check.js>>>\n' +
    'Waiting for the output.';
  for (let i = 0; i < src.length; i += 3) parser.feed(src.slice(i, i + 3));
  parser.finish();
  assert.deepEqual(ev.runs, ['node check.js']);
  assert.equal(ev.files.length, 1);
  assert.doesNotMatch(narrationText(), /<<<|RUN/);
});

test('RUN marker split across chunk boundaries still parses', () => {
  const { ev, parser } = collector();
  parser.feed('checking <<<RU');
  parser.feed('N: python te');
  parser.feed('st.py>>> done');
  parser.finish();
  assert.deepEqual(ev.runs, ['python test.py']);
});

test('think filter separates inline <think> spans from content', () => {
  const thinking = [];
  const content = [];
  const f = createThinkFilter({
    onThinking: (t) => thinking.push(t),
    onContent: (t) => content.push(t),
  });
  const stream = 'Hello <think>let me reason about this</think>world';
  for (let i = 0; i < stream.length; i += 4) f.feed(stream.slice(i, i + 4));
  f.flush();
  assert.equal(thinking.join(''), 'let me reason about this');
  assert.equal(content.join(''), 'Hello world');
});

test('think filter passes plain content through untouched', () => {
  const thinking = [];
  const content = [];
  const f = createThinkFilter({
    onThinking: (t) => thinking.push(t),
    onContent: (t) => content.push(t),
  });
  f.feed('no thinking here, just text');
  f.flush();
  assert.equal(thinking.length, 0);
  assert.equal(content.join(''), 'no thinking here, just text');
});

test('fitMessages keeps everything when the history fits', () => {
  const chat = [
    { role: 'user', content: 'make a page' },
    { role: 'assistant', content: 'done (wrote index.html, 100 chars)' },
  ];
  const { messages, dropped } = fitMessages({
    system: 'SYSTEM', chat, userMessage: 'now add css', numCtx: 32768,
  });
  assert.equal(dropped, 0);
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, 'now add css');
});

test('fitMessages drops oldest turns first and notes the elision', () => {
  const big = 'x'.repeat(4000); // ~1000 tokens each
  const chat = [];
  for (let i = 0; i < 20; i++) {
    chat.push({ role: 'user', content: `${i} ${big}` });
    chat.push({ role: 'assistant', content: `${i} ok ${big}` });
  }
  // budget: 8192 - 1024 reserve ≈ 7168 tokens, so only a few turns fit
  const { messages, dropped } = fitMessages({
    system: 'SYSTEM', chat, userMessage: 'continue', numCtx: 8192,
  });
  assert.ok(dropped > 0, 'drops some history');
  assert.match(messages[1].content, /omitted to fit the context window/);
  // the newest history survives, the oldest goes
  const bodies = messages.map((m) => m.content).join('\n');
  assert.match(bodies, /19 ok/);
  assert.doesNotMatch(bodies, /\b0 ok/);
  assert.equal(messages.at(-1).content, 'continue');
});

test('fitMessages survives a system prompt bigger than the window', () => {
  const chat = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  const { messages, dropped } = fitMessages({
    system: 'S'.repeat(100_000), chat, userMessage: 'go', numCtx: 4096,
  });
  assert.equal(dropped, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, 'go');
});
