'use strict';

/** Minimal leveled logger. One line per event, ISO timestamps, no deps. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

function setLevel(name) {
  threshold = LEVELS[name] ?? LEVELS.info;
}

function line(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  const out = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  (level === 'error' ? console.error : console.log)(out);
}

module.exports = {
  setLevel,
  debug: (msg, extra) => line('debug', msg, extra),
  info: (msg, extra) => line('info', msg, extra),
  warn: (msg, extra) => line('warn', msg, extra),
  error: (msg, extra) => line('error', msg, extra),
};
