'use strict';

/**
 * Project store: every project is a plain directory under projectsDir.
 * Replica-internal state (metadata, chat history) lives in a `.replica/`
 * subfolder so the project itself stays clean.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { safeJoin, PROJECT_ID_RE } = require('./security');

const TEXT_EXT = new Set([
  '.html', '.css', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.py',
  '.svg', '.ts', '.tsx', '.jsx', '.xml', '.yml', '.yaml', '.toml', '.sql',
  '.sh', '.bat', '.ps1', '.env', '.gitignore', '.csv',
]);

const SKIP_DIRS = new Set(['.replica', 'node_modules', '.git', '__pycache__']);

function ensureRoot() {
  fs.mkdirSync(config.projectsDir, { recursive: true });
}

function slugify(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (s || 'project') + '-' + crypto.randomBytes(2).toString('hex');
}

/** Absolute dir for an existing project id, or null. */
function projectDir(id) {
  if (!PROJECT_ID_RE.test(String(id))) return null;
  const dir = path.join(config.projectsDir, id);
  return fs.existsSync(dir) ? dir : null;
}

async function readMeta(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, '.replica', 'meta.json'), 'utf8')); }
  catch { return null; }
}

async function writeMeta(dir, meta) {
  await fsp.mkdir(path.join(dir, '.replica'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.replica', 'meta.json'), JSON.stringify(meta, null, 2));
}

async function readChat(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, '.replica', 'chat.json'), 'utf8')); }
  catch { return []; }
}

async function writeChat(dir, chat) {
  await fsp.mkdir(path.join(dir, '.replica'), { recursive: true });
  await fsp.writeFile(path.join(dir, '.replica', 'chat.json'), JSON.stringify(chat, null, 2));
}

/** Recursive file listing (paths relative to project root, forward slashes). */
async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await listFiles(full, base));
    } else {
      const st = await fsp.stat(full);
      out.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: st.size });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function listProjects() {
  ensureRoot();
  const out = [];
  for (const name of await fsp.readdir(config.projectsDir).catch(() => [])) {
    const dir = path.join(config.projectsDir, name);
    try {
      if (!(await fsp.stat(dir)).isDirectory()) continue;
    } catch { continue; }
    const meta = await readMeta(dir);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function createProject({ name, description, files }) {
  ensureRoot();
  const cleanName = String(name || 'Untitled project').slice(0, 80);
  const id = slugify(cleanName);
  const dir = path.join(config.projectsDir, id);
  await fsp.mkdir(dir, { recursive: true });
  const meta = {
    id,
    name: cleanName,
    description: String(description || '').slice(0, 500),
    published: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeMeta(dir, meta);
  await writeChat(dir, []);
  if (Array.isArray(files)) {
    for (const f of files.slice(0, 200)) {
      const full = safeJoin(dir, f.path);
      if (!full) continue;
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, String(f.content ?? ''), 'utf8');
    }
  }
  return meta;
}

async function deleteProject(id) {
  const dir = projectDir(id);
  if (!dir) return false;
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}

// ─── workspace state ────────────────────────────────────────────────────────
// Profile, preferences, and workspace name live server-side so every browser
// sees the same workspace. Stored as a plain JSON file next to the projects
// (listProjects skips non-directories, so it never shows up as a project).

function workspacePath() {
  return path.join(config.projectsDir, 'workspace.json');
}

async function readWorkspace() {
  try { return JSON.parse(await fsp.readFile(workspacePath(), 'utf8')); }
  catch { return {}; }
}

async function writeWorkspace(ws) {
  ensureRoot();
  const clean = {
    user: ws.user && typeof ws.user === 'object' ? ws.user : null,
    wsname: String(ws.wsname || '').slice(0, 80),
    model: String(ws.model || '').slice(0, 120),
    prefs: ws.prefs && typeof ws.prefs === 'object' ? ws.prefs : {},
  };
  await fsp.writeFile(workspacePath(), JSON.stringify(clean, null, 2));
  return clean;
}

// ─── checkpoints ────────────────────────────────────────────────────────────
// Before an agent turn touches a file, the pre-turn version is copied into
// .replica/history/<turnId>/files/<path>. Restoring a checkpoint unwinds
// every turn back to and including that one, newest first, consuming the
// checkpoints it applies (undo, no redo).

const HISTORY_KEEP = 50;

function historyRoot(dir) {
  return path.join(dir, '.replica', 'history');
}

/**
 * Start a checkpoint for one agent turn. record() must be called with each
 * file path *before* it is written or deleted; it saves the pre-turn version
 * exactly once per path. commit() writes the manifest and returns it (null
 * if the turn touched nothing). Both are synchronous so they can run inside
 * the streaming parser's event handlers.
 */
function createCheckpoint(dir, message) {
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const seen = new Map();
  let manifest = null;
  return {
    id,
    record(rel, full) {
      if (seen.has(rel)) return;
      const existed = fs.existsSync(full);
      if (existed) {
        const dest = path.join(historyRoot(dir), id, 'files', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
      }
      seen.set(rel, { path: rel, existed });
    },
    commit() {
      if (manifest) return manifest;
      if (!seen.size) return null;
      manifest = {
        id,
        at: Date.now(),
        message: String(message || '').slice(0, 200),
        files: [...seen.values()],
      };
      const base = path.join(historyRoot(dir), id);
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2));
      pruneCheckpoints(dir).catch(() => { /* best effort */ });
      return manifest;
    },
  };
}

/** All checkpoints for a project, newest first. */
async function listCheckpoints(dir) {
  const root = historyRoot(dir);
  const out = [];
  for (const name of await fsp.readdir(root).catch(() => [])) {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(root, name, 'manifest.json'), 'utf8'));
      out.push({ id: m.id, at: m.at, message: m.message, files: m.files.length });
    } catch { /* half-written checkpoint, skip */ }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

async function pruneCheckpoints(dir) {
  const all = await listCheckpoints(dir);
  for (const cp of all.slice(HISTORY_KEEP)) {
    await fsp.rm(path.join(historyRoot(dir), cp.id), { recursive: true, force: true });
  }
}

/**
 * Restore project files to the state before the given turn: apply every
 * checkpoint from the newest down to and including turnId, then remove the
 * consumed checkpoints. Returns the ids of the undone turns (newest first),
 * or null if the checkpoint does not exist.
 */
async function rollbackTo(dir, turnId) {
  const all = await listCheckpoints(dir);
  const idx = all.findIndex((c) => c.id === turnId);
  if (idx === -1) return null;
  const toUndo = all.slice(0, idx + 1);
  for (const cp of toUndo) {
    const base = path.join(historyRoot(dir), cp.id);
    let m;
    try { m = JSON.parse(await fsp.readFile(path.join(base, 'manifest.json'), 'utf8')); }
    catch { continue; }
    for (const f of m.files) {
      const full = safeJoin(dir, f.path);
      if (!full) continue;
      if (f.existed) {
        const snap = path.join(base, 'files', f.path);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.copyFile(snap, full);
      } else {
        await fsp.rm(full, { force: true }).catch(() => {});
      }
    }
    await fsp.rm(base, { recursive: true, force: true });
  }
  return toUndo.map((c) => c.id);
}

module.exports = {
  TEXT_EXT,
  ensureRoot,
  slugify,
  projectDir,
  readMeta,
  writeMeta,
  readChat,
  writeChat,
  listFiles,
  listProjects,
  createProject,
  deleteProject,
  readWorkspace,
  writeWorkspace,
  createCheckpoint,
  listCheckpoints,
  rollbackTo,
};
