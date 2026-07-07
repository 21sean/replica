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
};
