'use strict';

/**
 * HTTP application: request routing, static assets, project previews,
 * and per-request logging. Exposed as a factory so tests can boot the
 * whole app on an ephemeral port.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const proc = require('./proc');
const { send, sendJSON, serveFile, proxyRequest } = require('./httpx');
const { safeJoin } = require('./security');
const { handleAPI } = require('./routes');

const PREVIEW_PLACEHOLDER = `<!doctype html><meta charset="utf-8"><body style="background:#0E1525;color:#9DA2A6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#9DA2A6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="margin:0 auto 10px"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg><p>No index.html in this project yet.<br>Ask the Agent to build something.</p></div>`;

async function route(req, res, url) {
  const p = decodeURIComponent(url.pathname);

  if (p.startsWith('/api/')) return handleAPI(req, res, url);

  // project preview — no-store so edits show up on refresh
  const pm = p.match(/^\/preview\/([a-z0-9-]+)(\/.*)?$/);
  if (pm) {
    const dir = store.projectDir(pm[1]);
    if (!dir) return send(res, 404, 'Project not found');

    // a running dev server takes precedence over static files
    const up = proc.upstream(pm[1]);
    if (up) return proxyRequest(req, res, up.port, encodeURI(pm[2] || '/') + url.search);

    let rel = (pm[2] || '/').replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    let full = safeJoin(dir, rel);
    if (!full) return send(res, 400, 'Bad path');
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    if (!fs.existsSync(full)) {
      return send(res, 404, PREVIEW_PLACEHOLDER, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return serveFile(res, full, { 'Cache-Control': 'no-store' });
  }

  if (p === '/' || p === '/index.html') return serveFile(res, path.join(config.publicDir, 'index.html'));
  if (p === '/agent' || p === '/agent/') return serveFile(res, path.join(config.publicDir, 'agent.html'));
  if (p === '/products/agent' || p === '/products/agent/') return serveFile(res, path.join(config.publicDir, 'products-agent.html'));

  const full = safeJoin(config.publicDir, p);
  if (full && fs.existsSync(full) && fs.statSync(full).isFile()) return serveFile(res, full);
  return send(res, 404, 'Not found');
}

function createApp() {
  store.ensureRoot();
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.on('finish', () => {
      // chat streams can run for minutes; log them at completion like the rest
      log.debug(`${req.method} ${url.pathname} ${res.statusCode}`, { ms: Date.now() - started });
    });
    try {
      await route(req, res, url);
    } catch (e) {
      const code = e.statusCode || 500;
      if (code >= 500) log.error(`unhandled error on ${req.method} ${url.pathname}`, { error: e.message });
      if (!res.headersSent) sendJSON(res, code, { error: e.message });
      else res.end();
    }
  });
}

module.exports = { createApp };
