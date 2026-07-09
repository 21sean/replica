'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * All runtime configuration, sourced from the environment with safe defaults.
 * Replica binds to loopback by default — set HOST=0.0.0.0 explicitly to
 * expose it on a network.
 */
const config = {
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 4747),
  ollamaHost: (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, ''),

  publicDir: path.join(ROOT, 'public'),
  projectsDir: process.env.REPLICA_PROJECTS_DIR || path.join(ROOT, 'projects'),

  // request handling
  bodyLimitBytes: intEnv('REPLICA_BODY_LIMIT', 20 * 1024 * 1024),

  // agent / model settings
  temperature: floatEnv('REPLICA_TEMPERATURE', 0.4),
  numCtx: intEnv('REPLICA_NUM_CTX', 32768),
  keepAlive: process.env.REPLICA_KEEP_ALIVE || '20m',
  contextFileCap: intEnv('REPLICA_CONTEXT_FILE_CAP', 24_000),
  contextTotalCap: intEnv('REPLICA_CONTEXT_TOTAL_CAP', 90_000),
  ctxReserve: intEnv('REPLICA_CTX_RESERVE', 1024),
  agentMaxIters: intEnv('REPLICA_AGENT_MAX_ITERS', 3),

  // console command execution
  execTimeoutMs: intEnv('REPLICA_EXEC_TIMEOUT', 60_000),
  execOutputCap: intEnv('REPLICA_EXEC_OUTPUT_CAP', 200_000),

  logLevel: process.env.REPLICA_LOG_LEVEL || 'info',
};

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}
function floatEnv(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

module.exports = config;
