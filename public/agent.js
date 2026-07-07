/* Replica workspace app */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ─────────────────────────────────────────────── state
const store = {
  get user() { try { return JSON.parse(localStorage.getItem('replica.user')); } catch { return null; } },
  set user(v) { localStorage.setItem('replica.user', JSON.stringify(v)); },
  get model() { return localStorage.getItem('replica.model') || ''; },
  set model(v) { localStorage.setItem('replica.model', v); },
};

let models = [];
let current = null;          // {id, name, ...meta}
let streaming = false;
let streamAbort = null;
let openFile = null;         // path of file in editor
let editorDirty = false;
let previewTimer = null;

// ─────────────────────────────────────────────── boot
init();
async function init() {
  wireGlobalUI();
  await loadModels();
  checkHealth();
  setInterval(checkHealth, 15_000);

  if (!store.user) {
    $('#onboarding').classList.remove('hidden');
    $('#obUsername').focus();
  } else {
    applyUser();
  }

  const qp = new URLSearchParams(location.search).get('prompt');
  if (qp) {
    $('#homePrompt').value = qp;
    autosize($('#homePrompt'));
    history.replaceState({}, '', '/agent');
    $('#homePrompt').focus();
  }
}

function applyUser() {
  const u = store.user || {};
  const display = u.fullName || u.username || 'there';
  $('#greeting').textContent = `Hi ${display}, what do you want to make?`;
  $('#wsName').textContent = `${u.username || 'my'}'s Workspace`;
  $('#wsAvatar').textContent = (u.username || 'R')[0].toUpperCase();
}

// ─────────────────────────────────────────────── onboarding
function wireOnboarding() {
  $('#obNext1').onclick = () => {
    const username = $('#obUsername').value.trim().replace(/\s+/g, '').toLowerCase();
    if (!username) return $('#obUsername').focus();
    if (!$('#obFullname').value.trim()) $('#obFullname').value = username[0].toUpperCase() + username.slice(1);
    $('#obStep1').classList.add('hidden');
    $('#obStep2').classList.remove('hidden');
  };
  $('#obBack').onclick = () => {
    $('#obStep2').classList.add('hidden');
    $('#obStep1').classList.remove('hidden');
  };
  let role = '';
  $('#roleGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.role');
    if (!b) return;
    $$('#roleGrid .role').forEach((r) => r.classList.remove('sel'));
    b.classList.add('sel');
    role = b.textContent;
  });
  $('#obFinish').onclick = () => {
    store.user = {
      username: $('#obUsername').value.trim().replace(/\s+/g, '').toLowerCase() || 'builder',
      fullName: $('#obFullname').value.trim(),
      role,
    };
    $('#onboarding').classList.add('hidden');
    applyUser();
    $('#homePrompt').focus();
  };
}

// ─────────────────────────────────────────────── global UI wiring
function wireGlobalUI() {
  wireOnboarding();

  // sidebar nav
  $$('.nav-item[data-view]').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view)));
  $('#btnNew').onclick = () => { showView('home'); $('#homePrompt').focus(); };
  $('#navSettings').onclick = openSettings;
  $('#navDocs').onclick = () => $('#docsModal').classList.remove('hidden');
  $$('.modal-x').forEach((b) => b.onclick = () => $('#' + b.dataset.close).classList.add('hidden'));
  $$('.modal-backdrop').forEach((m) =>
    m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'onboarding') m.classList.add('hidden'); }));

  // import
  $('#btnImport').onclick = () => $('#importInput').click();
  $('#importInput').addEventListener('change', importFiles);

  // home prompt
  const hp = $('#homePrompt');
  hp.addEventListener('input', () => autosize(hp));
  hp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startFromHome(); }
  });
  $('#homeSend').onclick = startFromHome;
  $$('#catRow .cat').forEach((c) => c.onclick = () => { hp.value = c.dataset.p; hp.focus(); autosize(hp); });
  $$('.ex').forEach((c) => c.onclick = () => { hp.value = c.dataset.p; hp.focus(); autosize(hp); });

  // rotating placeholder
  const ideas = ['Make a mobile app for…', 'Build a website for…', 'Create a game about…', 'Design a dashboard for…', 'Animate something that…'];
  let ii = 0;
  setInterval(() => { if (!hp.value) hp.placeholder = ideas[++ii % ideas.length]; }, 3000);

  // model pickers stay in sync
  $('#homeModel').addEventListener('change', () => { store.model = $('#homeModel').value; syncModelPickers(); });
  $('#wsModel').addEventListener('change', () => { store.model = $('#wsModel').value; syncModelPickers(); });

  // workspace toolbar
  $('#wsBack').onclick = () => { current = null; showView('projects'); loadProjects(); };
  $('#btnOpenTab').onclick = () => { if (current) window.open(`/preview/${current.id}/`, '_blank'); };
  $('#btnRefresh').onclick = refreshPreview;

  // panel tabs
  $$('.ptab').forEach((t) => t.addEventListener('click', () => {
    $$('.ptab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $$('.ptab-view').forEach((v) => v.classList.add('hidden'));
    $('#tab-' + t.dataset.tab).classList.remove('hidden');
    if (t.dataset.tab === 'code') loadTree();
    if (t.dataset.tab === 'console') $('#consoleCmd').focus();
  }));

  // chat input
  const ct = $('#chatText');
  ct.addEventListener('input', () => autosize(ct));
  ct.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chatSend').onclick = sendChat;
  $('#chatStop').onclick = () => { if (streamAbort) streamAbort.abort(); };

  // editor
  const ed = $('#editor');
  ed.addEventListener('input', () => { markDirty(true); renderLineNums(); });
  ed.addEventListener('scroll', () => { $('#lineNums').scrollTop = ed.scrollTop; });
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ed.selectionStart;
      ed.setRangeText('  ', s, ed.selectionEnd, 'end');
      markDirty(true);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  });
  $('#btnSaveFile').onclick = saveFile;
  $('#btnNewFile').onclick = newFile;
  $('#btnDeleteFile').onclick = deleteFile;

  // console
  $('#consoleCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(); });

  // settings
  $('#setSave').onclick = saveSettings;
}

function autosize(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'projects') loadProjects();
}

// ─────────────────────────────────────────────── health + models
async function checkHealth() {
  const el = $('#ollamaStatus');
  try {
    const h = await (await fetch('/api/health')).json();
    el.className = 'ollama-status ' + (h.ollama ? 'ok' : 'bad');
    el.innerHTML = `<span class="dot"></span> ${h.ollama ? 'Ollama connected' : 'Ollama offline'}`;
  } catch {
    el.className = 'ollama-status bad';
    el.innerHTML = '<span class="dot"></span> server offline';
  }
}

async function loadModels() {
  try {
    const j = await (await fetch('/api/models')).json();
    models = j.models || [];
  } catch { models = []; }
  if (!store.model || !models.some((m) => m.name === store.model)) {
    // prefer the biggest capable-looking model as default
    const pref = models.find((m) => /qwen3/i.test(m.name)) || models[0];
    if (pref) store.model = pref.name;
  }
  syncModelPickers();
}

function syncModelPickers() {
  for (const sel of [$('#homeModel'), $('#wsModel'), $('#setModel')]) {
    sel.innerHTML = models.length
      ? models.map((m) => `<option value="${esc(m.name)}"${m.name === store.model ? ' selected' : ''}>${esc(m.name)}${m.params ? ` · ${esc(m.params)}` : ''}</option>`).join('')
      : '<option value="">no models — is Ollama running?</option>';
  }
}

// ─────────────────────────────────────────────── projects
async function loadProjects() {
  const j = await (await fetch('/api/projects')).json();
  const grid = $('#projGrid');
  grid.innerHTML = '';
  $('#projEmpty').classList.toggle('hidden', j.projects.length > 0);
  for (const p of j.projects) {
    const card = document.createElement('div');
    card.className = 'proj-card';
    card.innerHTML = `
      <button class="proj-del" title="Delete project">🗑</button>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description || 'No description')}</p>
      <span class="when">updated ${timeAgo(p.updatedAt)}</span>`;
    card.onclick = (e) => { if (!e.target.closest('.proj-del')) openProject(p); };
    card.querySelector('.proj-del').onclick = async () => {
      if (!confirm(`Delete "${p.name}" and all its files? This cannot be undone.`)) return;
      await fetch('/api/projects/' + p.id, { method: 'DELETE' });
      loadProjects();
    };
    grid.appendChild(card);
  }
}

function deriveName(prompt) {
  const words = prompt.replace(/[^\w\s-]/g, ' ').trim().split(/\s+/)
    .filter((w) => !/^(a|an|the|for|with|and|to|of|me|my|please|build|make|create|design|that|app|website)$/i.test(w));
  const base = (words.slice(0, 4).join(' ') || prompt.split(/\s+/).slice(0, 4).join(' ')).slice(0, 48);
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) || 'New Project';
}

async function startFromHome() {
  const prompt = $('#homePrompt').value.trim();
  if (!prompt || streaming) return;
  const meta = await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: deriveName(prompt), description: prompt }),
  })).json();
  $('#homePrompt').value = '';
  await openProject(meta);
  sendChat(prompt);
}

async function importFiles(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const name = prompt('Name for the imported project:', files[0].name.replace(/\.[^.]+$/, ''));
  if (name === null) return;
  const payload = [];
  for (const f of files.slice(0, 100)) {
    if (f.size > 2 * 1024 * 1024) continue;
    payload.push({ path: f.name, content: await f.text() });
  }
  const meta = await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || 'Imported project', description: `Imported ${payload.length} file(s)`, files: payload }),
  })).json();
  openProject(meta);
}

// ─────────────────────────────────────────────── workspace
async function openProject(meta) {
  current = meta;
  openFile = null;
  editorDirty = false;
  $('#wsTitle').textContent = meta.name;
  $('#editor').value = '';
  $('#editor').disabled = true;
  $('#editorPath').textContent = 'select a file';
  $('#chatScroll').innerHTML = '';
  showView('workspace');
  refreshPreview();

  // restore chat history
  const j = await (await fetch(`/api/projects/${meta.id}/files`)).json();
  current = j.meta || meta;
  const chat = j.chat || [];
  if (!chat.length) {
    $('#chatScroll').innerHTML = `<div class="chat-welcome"><span class="big">🤖</span>Tell the Agent what to build.<br>It writes real files into this project as it answers.</div>`;
  }
  for (const m of chat) {
    if (m.role === 'user') addUserMsg(m.content);
    else renderHistoryTurn(m.content);
  }
  scrollChat(true);
  loadTree();
}

function renderHistoryTurn(content) {
  const turn = document.createElement('div');
  turn.className = 'turn';
  const narr = [];
  const ops = [];
  for (const line of content.split('\n')) {
    const w = line.match(/^\(wrote (.+?), \d+ chars(, TRUNCATED.*)?\)$/) || line.match(/^\(wrote (.+?)\)$/);
    const d = line.match(/^\(deleted (.+?)\)$/);
    if (w) ops.push({ path: w[1], del: false });
    else if (d) ops.push({ path: d[1], del: true });
    else if (line !== '(interrupted)') narr.push(line);
  }
  if (narr.join('').trim()) {
    const n = document.createElement('div');
    n.className = 'turn-narration';
    n.textContent = narr.join('\n').trim();
    turn.appendChild(n);
  }
  if (ops.length) {
    const wrap = document.createElement('div');
    wrap.className = 'fileops';
    for (const o of ops) {
      const el = document.createElement('div');
      el.className = 'fileop done' + (o.del ? ' del' : '');
      el.innerHTML = `<span class="st">${o.del ? '✕' : '✓'}</span><span>${esc(o.path)}</span>`;
      wrap.appendChild(el);
    }
    turn.appendChild(wrap);
  }
  $('#chatScroll').appendChild(turn);
}

function addUserMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg-user';
  el.textContent = text;
  $('#chatScroll').appendChild(el);
}

function scrollChat(force) {
  const sc = $('#chatScroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}

// ─────────────────────────────────────────────── chat streaming
async function sendChat(presetText) {
  if (streaming || !current) return;
  const text = (typeof presetText === 'string' ? presetText : $('#chatText').value).trim();
  if (!text) return;
  $('#chatText').value = '';
  autosize($('#chatText'));
  $('#chatScroll').querySelector('.chat-welcome')?.remove();
  addUserMsg(text);

  streaming = true;
  $('#chatSend').classList.add('hidden');
  $('#chatStop').classList.remove('hidden');

  // build the live turn
  const turn = document.createElement('div');
  turn.className = 'turn';
  const status = document.createElement('div');
  status.className = 'status-line';
  status.innerHTML = `<span class="spinner"></span><span>Waking ${esc(store.model)}…</span>`;
  turn.appendChild(status);
  $('#chatScroll').appendChild(turn);
  scrollChat(true);

  let thinkEl = null, thinkBody = null, thinkStart = 0;
  let narrEl = null;
  const opEls = new Map();
  let filesTouched = false;

  const ensureThink = () => {
    if (thinkEl) return;
    thinkStart = Date.now();
    thinkEl = document.createElement('div');
    thinkEl.className = 'think open';
    thinkEl.innerHTML = `<div class="think-head"><span class="chev">▶</span><span class="spinner"></span><span class="th-label">Thinking…</span></div><div class="think-body"></div>`;
    thinkBody = thinkEl.querySelector('.think-body');
    thinkEl.querySelector('.think-head').onclick = () => thinkEl.classList.toggle('open');
    turn.appendChild(thinkEl);
  };
  const closeThink = () => {
    if (!thinkEl || !thinkEl.classList.contains('open')) return;
    thinkEl.classList.remove('open');
    const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
    thinkEl.querySelector('.spinner')?.remove();
    thinkEl.querySelector('.th-label').textContent = `Thought for ${secs}s`;
  };
  const ensureNarr = () => {
    closeThink();
    if (!narrEl || turn.lastElementChild !== narrEl) {
      narrEl = document.createElement('div');
      narrEl.className = 'turn-narration';
      turn.appendChild(narrEl);
    }
    return narrEl;
  };
  const opEl = (path) => {
    let el = opEls.get(path);
    if (el) return el;
    closeThink();
    let wrap = turn.lastElementChild?.classList.contains('fileops') ? turn.lastElementChild : null;
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'fileops'; turn.appendChild(wrap); }
    el = document.createElement('div');
    el.className = 'fileop';
    el.innerHTML = `<span class="st"><span class="spinner"></span></span><span class="fpath">${esc(path)}</span><span class="fsize"></span>`;
    wrap.appendChild(el);
    opEls.set(path, el);
    narrEl = null; // next narration starts a fresh block after the file list
    return el;
  };

  streamAbort = new AbortController();
  let gotFirst = false;
  try {
    const resp = await fetch(`/api/projects/${current.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, model: store.model }),
      signal: streamAbort.signal,
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!gotFirst) { gotFirst = true; status.remove(); }
        handleEvent(ev);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      const el = document.createElement('div');
      el.className = 'err-line';
      el.textContent = 'Connection error: ' + e.message;
      turn.appendChild(el);
    }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'thinking':
        ensureThink();
        thinkBody.textContent += ev.text;
        thinkBody.scrollTop = thinkBody.scrollHeight;
        break;
      case 'token':
        ensureNarr().textContent += ev.text;
        break;
      case 'fileStart':
        opEl(ev.path);
        break;
      case 'fileChunk': {
        const el = opEl(ev.path);
        el.querySelector('.fsize').textContent = fmtBytes(ev.bytes);
        break;
      }
      case 'fileDone': {
        filesTouched = true;
        const el = opEl(ev.path);
        el.classList.add('done');
        el.querySelector('.st').innerHTML = ev.truncated ? '⚠' : '✓';
        el.querySelector('.fsize').textContent = fmtBytes(ev.bytes);
        schedulePreview();
        break;
      }
      case 'deleted': {
        filesTouched = true;
        const el = opEl(ev.path);
        el.classList.add('done', 'del');
        el.querySelector('.st').textContent = '✕';
        break;
      }
      case 'error': {
        const el = document.createElement('div');
        el.className = 'err-line';
        el.textContent = ev.message;
        turn.appendChild(el);
        break;
      }
      case 'done':
        closeThink();
        break;
    }
    // trim empty narration nodes the stream can produce around file blocks
    if (narrEl && !narrEl.textContent.trim() && ev.type !== 'token') { narrEl.remove(); narrEl = null; }
    scrollChat();
  }

  closeThink();
  status.remove();
  streaming = false;
  streamAbort = null;
  $('#chatSend').classList.remove('hidden');
  $('#chatStop').classList.add('hidden');
  if (filesTouched) { refreshPreview(); loadTree(); }
  scrollChat();
  $('#chatText').focus();
}

// ─────────────────────────────────────────────── preview
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 900);
}
function refreshPreview() {
  if (!current) return;
  $('#previewFrame').src = `/preview/${current.id}/?t=${Date.now()}`;
}

// ─────────────────────────────────────────────── code tab
async function loadTree() {
  if (!current) return;
  const j = await (await fetch(`/api/projects/${current.id}/files`)).json();
  const tree = $('#fileTree');
  tree.innerHTML = '';
  if (!j.files.length) {
    tree.innerHTML = '<div class="ft-dir" style="padding:12px 8px">no files yet</div>';
    return;
  }
  // group by top-level dir
  let lastDir = null;
  for (const f of j.files) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (dir !== lastDir && dir) {
      const d = document.createElement('div');
      d.className = 'ft-dir';
      d.textContent = '▸ ' + dir + '/';
      tree.appendChild(d);
    }
    lastDir = dir;
    const b = document.createElement('button');
    b.className = 'ft-file' + (f.path === openFile ? ' active' : '');
    b.innerHTML = `<span class="fic">${fileIcon(f.path)}</span>${esc(parts[parts.length - 1])}`;
    b.title = f.path;
    b.onclick = () => loadFile(f.path);
    tree.appendChild(b);
  }
}

function fileIcon(p) {
  const ext = p.split('.').pop().toLowerCase();
  return { html: '⬡', css: '#', js: 'ƒ', mjs: 'ƒ', json: '{}', md: '¶', py: '🐍', svg: '◈', txt: '¶' }[ext] || '·';
}

async function loadFile(path) {
  if (editorDirty && !confirm('Discard unsaved changes?')) return;
  const j = await (await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(path)}`)).json();
  if (j.error) return;
  openFile = path;
  $('#editor').value = j.content;
  $('#editor').disabled = false;
  $('#editorPath').textContent = path;
  markDirty(false);
  renderLineNums();
  $$('.ft-file').forEach((b) => b.classList.toggle('active', b.title === path));
}

function renderLineNums() {
  const n = $('#editor').value.split('\n').length;
  $('#lineNums').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
}

function markDirty(v) {
  editorDirty = v;
  $('#editorDirty').classList.toggle('hidden', !v);
}

async function saveFile() {
  if (!openFile || !current) return;
  await fetch(`/api/projects/${current.id}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: openFile, content: $('#editor').value }),
  });
  markDirty(false);
  schedulePreview();
}

async function newFile() {
  const path = prompt('New file path (e.g. notes.md or js/util.js):');
  if (!path || !current) return;
  await fetch(`/api/projects/${current.id}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content: '' }),
  });
  await loadTree();
  loadFile(path.replace(/\\/g, '/').replace(/^\/+/, ''));
}

async function deleteFile() {
  if (!openFile || !current) return;
  if (!confirm(`Delete ${openFile}?`)) return;
  await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(openFile)}`, { method: 'DELETE' });
  openFile = null;
  $('#editor').value = '';
  $('#editor').disabled = true;
  $('#editorPath').textContent = 'select a file';
  markDirty(false);
  loadTree();
  schedulePreview();
}

// ─────────────────────────────────────────────── console
async function runCommand() {
  const inp = $('#consoleCmd');
  const cmd = inp.value.trim();
  if (!cmd || !current) return;
  inp.value = '';
  const out = $('#consoleOut');
  out.querySelector('.con-hint')?.remove();
  out.innerHTML += `<span class="con-cmd">$ ${esc(cmd)}</span>\n`;
  out.scrollTop = out.scrollHeight;
  try {
    const j = await (await fetch(`/api/projects/${current.id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    })).json();
    if (j.error) out.innerHTML += `<span class="con-err">${esc(j.error)}</span>\n`;
    else {
      if (j.output) out.innerHTML += esc(j.output.replace(/\x1b\[[0-9;]*m/g, '')) + '\n';
      out.innerHTML += j.ok
        ? `<span style="color:var(--green)">✓ exit 0</span>\n\n`
        : `<span class="con-err">✗ exit ${j.code}${j.timedOut ? ' (timed out)' : ''}</span>\n\n`;
    }
  } catch (e) {
    out.innerHTML += `<span class="con-err">${esc(e.message)}</span>\n`;
  }
  out.scrollTop = out.scrollHeight;
}

// ─────────────────────────────────────────────── settings
function openSettings() {
  const u = store.user || {};
  $('#setUsername').value = u.username || '';
  $('#setFullname').value = u.fullName || '';
  syncModelPickers();
  fetch('/api/health').then((r) => r.json()).then((h) => {
    $('#settingsInfo').innerHTML =
      `Ollama host: <code>${esc(h.ollamaHost)}</code> — ${h.ollama ? '🟢 connected' : '🔴 offline'}<br>` +
      `Projects live in <code>replica/projects/</code> next to server.js<br>` +
      `Everything runs locally. No accounts, no billing, no telemetry.`;
  });
  $('#settingsModal').classList.remove('hidden');
}

function saveSettings() {
  const u = store.user || {};
  u.username = $('#setUsername').value.trim() || u.username || 'builder';
  u.fullName = $('#setFullname').value.trim();
  store.user = u;
  if ($('#setModel').value) store.model = $('#setModel').value;
  syncModelPickers();
  applyUser();
  $('#settingsModal').classList.add('hidden');
}

// ─────────────────────────────────────────────── utils
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(n) {
  if (n == null) return '';
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}
function timeAgo(ts) {
  if (!ts) return 'just now';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
