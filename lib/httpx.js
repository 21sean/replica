'use strict';

const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');

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

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS, ...headers });
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = config.bodyLimitBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

async function serveFile(res, full, extraHeaders = {}) {
  try {
    const data = await fsp.readFile(full);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, ...BASE_HEADERS, ...extraHeaders });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

/**
 * Proxy a request to a project process on 127.0.0.1:<port>. Streams the
 * body both ways; 502s if the process stops answering mid-flight.
 */
function proxyRequest(req, res, port, targetPath) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const up = http.request(
    { host: '127.0.0.1', port, path: targetPath, method: req.method, headers },
    (ur) => {
      res.writeHead(ur.statusCode, { ...ur.headers, 'cache-control': 'no-store' });
      ur.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) send(res, 502, 'The app process is not responding. Check the Console tab.');
    else res.end();
  });
  req.pipe(up);
}

module.exports = { MIME, send, sendJSON, readBody, readJSON, serveFile, proxyRequest };
