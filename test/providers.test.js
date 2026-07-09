'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../lib/providers/claudeCli');

test('claude parseStreamLine maps text deltas to content events', () => {
  const line = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } };
  assert.deepEqual(claude.parseStreamLine(line), [{ message: { content: 'hello' } }]);
});

test('claude parseStreamLine maps thinking deltas to thinking events', () => {
  const line = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } };
  assert.deepEqual(claude.parseStreamLine(line), [{ message: { thinking: 'hmm' } }]);
});

test('claude parseStreamLine ignores signature deltas and control events', () => {
  assert.deepEqual(claude.parseStreamLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'signature_delta' } } }), []);
  assert.deepEqual(claude.parseStreamLine({ type: 'stream_event', event: { type: 'message_stop' } }), []);
  assert.deepEqual(claude.parseStreamLine({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(claude.parseStreamLine({ type: 'result', is_error: false, result: 'AAA' }), []);
});

test('claude parseStreamLine surfaces errors, with a friendly not-logged-in message', () => {
  const bad = claude.parseStreamLine({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
  assert.equal(bad.length, 1);
  assert.match(bad[0].error, /claude login/);

  const other = claude.parseStreamLine({ type: 'result', is_error: true, result: 'model overloaded' });
  assert.deepEqual(other, [{ error: 'model overloaded' }]);
});

test('claude splitMessages joins system messages and labels the transcript', () => {
  const { systemPrompt, userPrompt } = claude.splitMessages([
    { role: 'system', content: 'PROTOCOL' },
    { role: 'system', content: 'FILES' },
    { role: 'user', content: 'make a todo app' },
    { role: 'assistant', content: '(wrote index.html)' },
    { role: 'user', content: 'add dark mode' },
  ]);
  assert.equal(systemPrompt, 'PROTOCOL\n\nFILES');
  assert.match(userPrompt, /## USER\nmake a todo app/);
  assert.match(userPrompt, /## ASSISTANT\n\(wrote index\.html\)/);
  assert.match(userPrompt, /## USER\nadd dark mode$/);
});

test('provider registry lists ollama-shaped ids and merges providers', async () => {
  const providers = require('../lib/providers');
  // claude catalog carries namespaced ids + provider tag
  const cm = claude.listModels();
  assert.ok(cm.every((m) => m.id.startsWith('claude:') && m.provider === 'claude'));
  assert.equal(typeof providers.chatStream, 'function');
});
