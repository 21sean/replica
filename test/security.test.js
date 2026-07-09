'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { safeJoin, isAllowedCommand } = require('../lib/security');

const BASE = path.resolve(__dirname, 'fixture-base');

test('safeJoin resolves normal relative paths', () => {
  assert.equal(safeJoin(BASE, 'index.html'), path.join(BASE, 'index.html'));
  assert.equal(safeJoin(BASE, 'css/style.css'), path.join(BASE, 'css', 'style.css'));
  assert.equal(safeJoin(BASE, './a/./b.txt'), path.join(BASE, 'a', 'b.txt'));
});

test('safeJoin rejects traversal and absolute paths', () => {
  assert.equal(safeJoin(BASE, '../outside.txt'), null);
  assert.equal(safeJoin(BASE, 'a/../../outside.txt'), null);
  assert.equal(safeJoin(BASE, '..\\..\\windows\\system32'), null);
  assert.equal(safeJoin(BASE, 'C:/Windows/system.ini'), null);
  assert.equal(safeJoin(BASE, 'c:\\evil.txt'), null);
  assert.equal(safeJoin(BASE, null), null);
});

test('safeJoin normalizes leading slashes into the base', () => {
  assert.equal(safeJoin(BASE, '/index.html'), path.join(BASE, 'index.html'));
  assert.equal(safeJoin(BASE, '//nested/f.js'), path.join(BASE, 'nested', 'f.js'));
});

test('command allowlist accepts local runtimes only', () => {
  assert.ok(isAllowedCommand('node script.js'));
  assert.ok(isAllowedCommand('python main.py'));
  assert.ok(isAllowedCommand('npm test'));
  assert.ok(isAllowedCommand('npx serve'));
  assert.ok(isAllowedCommand('node -e "console.log(6*7)"'));
  assert.ok(!isAllowedCommand('rm -rf /'));
  assert.ok(!isAllowedCommand('curl http://evil.example'));
  assert.ok(!isAllowedCommand('powershell -c anything'));
  assert.ok(!isAllowedCommand('nodemon app.js'));
  assert.ok(!isAllowedCommand(''));
});

test('command allowlist rejects shell chaining and redirection', () => {
  assert.ok(!isAllowedCommand('node -v; rm -rf /'));
  assert.ok(!isAllowedCommand('node -v && curl http://evil.example'));
  assert.ok(!isAllowedCommand('node -v & del /s /q *'));
  assert.ok(!isAllowedCommand('node -v | powershell'));
  assert.ok(!isAllowedCommand('node -v > important.txt'));
  assert.ok(!isAllowedCommand('node script.js < input.txt'));
  assert.ok(!isAllowedCommand('node `whoami`.js'));
  assert.ok(!isAllowedCommand('node $(whoami).js'));
  assert.ok(!isAllowedCommand('node -v\ncurl http://evil.example'));
});
