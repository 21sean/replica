'use strict';

/**
 * Long-running project processes: one dev server per project, started from
 * the workspace Run button (or the agent's run command). The child gets a
 * free port in PORT; once it accepts connections the preview proxies to it.
 * Output lands in a ring buffer the UI polls incrementally.
 */

const { spawn } = require('child_process');
const net = require('net');
const log = require('./log');

const LOG_KEEP = 2000;

const procs = new Map(); // project id -> record

function record(id) {
  return procs.get(id) || null;
}

/** Find a free loopback port by binding to 0 and releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function pushLog(rec, stream, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    rec.logs.push({ i: ++rec.logIndex, s: stream, text: line.slice(0, 4000) });
  }
  if (rec.logs.length > LOG_KEEP) rec.logs.splice(0, rec.logs.length - LOG_KEEP);
}

function alive(rec) {
  return !!rec && rec.child.exitCode === null && rec.child.signalCode === null && !rec.stopped;
}

/** Public status for one project's process. */
function status(id) {
  const rec = record(id);
  if (!rec) return { running: false };
  return {
    running: alive(rec),
    up: alive(rec) && rec.up,
    command: rec.command,
    port: rec.port,
    startedAt: rec.startedAt,
    exitCode: rec.child.exitCode,
  };
}

/** The record if its process is proxy-ready, else null. */
function upstream(id) {
  const rec = record(id);
  return alive(rec) && rec.up ? rec : null;
}

/**
 * Start (or restart) the project's process. The command must already be
 * allowlist-checked by the caller. Resolves once the child is spawned;
 * readiness is tracked in the background.
 */
async function start(id, dir, command) {
  await stop(id);
  const port = await freePort();
  const child = spawn(command, {
    cwd: dir,
    shell: true,
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  const rec = {
    id,
    command,
    port,
    child,
    logs: [],
    logIndex: 0,
    up: false,
    stopped: false,
    startedAt: Date.now(),
    probe: null,
  };
  procs.set(id, rec);
  pushLog(rec, 'sys', `$ ${command}  (PORT=${port})`);
  child.stdout.on('data', (d) => pushLog(rec, 'out', d));
  child.stderr.on('data', (d) => pushLog(rec, 'err', d));
  child.on('error', (e) => pushLog(rec, 'err', `failed to start: ${e.message}`));
  child.on('exit', (code, signal) => {
    rec.up = false;
    clearInterval(rec.probe);
    pushLog(rec, 'sys', `process exited with ${signal ? 'signal ' + signal : 'code ' + code}`);
    log.info('project process exited', { project: id, code, signal });
  });

  // probe the port until the app accepts connections, then mark it proxy-ready
  rec.probe = setInterval(() => {
    if (!alive(rec)) return clearInterval(rec.probe);
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => {
      sock.destroy();
      if (!rec.up) {
        rec.up = true;
        pushLog(rec, 'sys', `listening on port ${port}, preview is proxying to it`);
      }
      clearInterval(rec.probe);
    });
    sock.once('error', () => sock.destroy());
  }, 300);
  rec.probe.unref?.();

  log.info('project process started', { project: id, command, port, pid: child.pid });
  return status(id);
}

/** Stop the project's process (tree-kill so shell children die too). */
function stop(id) {
  const rec = record(id);
  if (!rec || !alive(rec)) return Promise.resolve(false);
  rec.stopped = true;
  rec.up = false;
  clearInterval(rec.probe);
  const pid = rec.child.pid;
  return new Promise((resolve) => {
    rec.child.once('exit', () => resolve(true));
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
        .once('error', () => { try { rec.child.kill(); } catch { /* already gone */ } });
    } else {
      try { rec.child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { rec.child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
    }
    // don't hang callers if the process refuses to die
    setTimeout(() => resolve(true), 5000).unref();
  });
}

/** Incremental log read: entries with i > after. */
function logs(id, after = 0) {
  const rec = record(id);
  if (!rec) return { lines: [], last: after, ...status(id) };
  const lines = rec.logs.filter((l) => l.i > after);
  return { lines, last: rec.logIndex, ...status(id) };
}

/** Kill everything (server shutdown). */
function stopAll() {
  const all = [...procs.keys()].map((id) => stop(id));
  return Promise.all(all);
}

module.exports = { start, stop, stopAll, status, logs, upstream };
