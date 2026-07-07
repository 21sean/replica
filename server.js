#!/usr/bin/env node
'use strict';

/**
 * Replica — a local Replit-style workspace powered by Ollama.
 * Zero npm dependencies. Node 18+ required (uses built-in fetch).
 *
 *   node server.js          → http://127.0.0.1:4747
 *
 * Configuration is environment-driven; see lib/config.js and docs/.
 */

const config = require('./lib/config');
const log = require('./lib/log');
const { createApp } = require('./lib/app');

log.setLevel(config.logLevel);

const server = createApp();

// track open sockets so shutdown can't hang on long-lived agent streams
const sockets = new Set();
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});

server.listen(config.port, config.host, () => {
  log.info(`Replica listening on http://${config.host}:${config.port}`);
  log.info(`marketing page  → http://${config.host}:${config.port}/`);
  log.info(`agent workspace → http://${config.host}:${config.port}/agent`);
  log.info(`ollama backend  → ${config.ollamaHost}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    log.info('server closed');
    process.exit(0);
  });
  // give in-flight requests a moment, then force-close remaining sockets
  setTimeout(() => {
    for (const s of sockets) s.destroy();
  }, 3000).unref();
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: e?.message || String(e) }));
