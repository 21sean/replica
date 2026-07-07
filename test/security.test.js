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
  assert.ok(!isAllowedCommand('rm -rf /'));
  assert.ok(!isAllowedCommand('curl http://evil.example'));
  assert.ok(!isAllowedCommand('powershell -c anything'));
  assert.ok(!isAllowedCommand('nodemon app.js'));
  assert.ok(!isAllowedCommand(''));
});
