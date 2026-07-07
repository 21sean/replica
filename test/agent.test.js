'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentParser, createThinkFilter } = require('../lib/agent');

/** Collect parser events into arrays for assertion. */
function collector() {
  const ev = { narration: [], files: [], deletes: [], starts: [] };
  const parser = createAgentParser({
    narration: (t) => ev.narration.push(t),
    fileStart: (p) => ev.starts.push(p),
    fileChunk: () => {},
    fileDone: (p, content, truncated) => ev.files.push({ path: p, content, truncated }),
    del: (p) => ev.deletes.push(p),
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
