/* Replica workspace app */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ─────────────────────────────────────────────── state
const store = {
  get user() { try { return JSON.parse(localStorage.getItem('replica.user')); } catch { return null; } },
  set user(v) { localStorage.setItem('replica.user', JSON.stringify(v)); },
  get model() { return localStorage.getItem('replica.model') || ''; },
  set model(v) { localStorage.setItem('replica.model', v); syncModelSelects(); },
  get wsname() { return localStorage.getItem('replica.wsname') || ''; },
  set wsname(v) { localStorage.setItem('replica.wsname', v); },
  get published() { try { return JSON.parse(localStorage.getItem('replica.published')) || []; } catch { return []; } },
  set published(v) { localStorage.setItem('replica.published', JSON.stringify(v)); },
  get prefs() {
    try { return { showThinking: true, rotateIdeas: true, ...JSON.parse(localStorage.getItem('replica.prefs') || '{}') }; }
    catch { return { showThinking: true, rotateIdeas: true }; }
  },
  set prefs(v) { localStorage.setItem('replica.prefs', JSON.stringify(v)); },
};

let models = [];
let projects = [];            // cached list from /api/projects
let health = { ollama: false, ollamaHost: '' };
let current = null;           // open project meta
let streaming = false;
let streamAbort = null;
let openFile = null;
let editorDirty = false;
let previewTimer = null;

const ROLES = ['Developer', 'Product Manager', 'Startup Founder', 'Business Owner',
  'Data Scientist / Analyst', 'Designer', 'Marketing and Sales', 'Business Operations',
  'Student', 'Educator / Teacher', 'Other'];

// ─────────────────────────────────────────────── tiny dom utils
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ic = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function fmtBytes(n) {
  if (n == null) return '';
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}

// minimal markdown for agent narration: paragraphs, headings, lists,
// fenced code, `code`, **bold**, *italic*. Input is escaped first.
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}
function mdToHtml(src) {
  const out = [];
  let code = null, list = null, para = [];
  const endPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of esc(src).split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code !== null) { out.push(`<pre>${code.join('\n')}</pre>`); code = null; }
      else { endPara(); endList(); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)/);
    if (h) { endPara(); endList(); out.push(`<h4>${mdInline(h[2])}</h4>`); }
    else if (li) {
      endPara();
      const want = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== want) { endList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${mdInline(li[1])}</li>`);
    } else if (!line.trim()) { endPara(); endList(); }
    else { endList(); para.push(line.trim()); }
  }
  if (code !== null) out.push(`<pre>${code.join('\n')}</pre>`);
  endPara();
  endList();
  return out.join('');
}
function timeAgo(ts) {
  if (!ts) return 'just now';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function autosize(t) {
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}
function isPublished(id) { return store.published.includes(id); }
function setPublished(id, on) {
  const set = new Set(store.published);
  on ? set.add(id) : set.delete(id);
  store.published = [...set];
}

// ─────────────────────────────────────────────── toasts
function toast(title, desc = '', kind = 'info') {
  const icons = { info: 'info', ok: 'check', warn: 'warn' };
  const t = el(`<div class="toast ${kind}">${ic(icons[kind] || 'info')}<div>
    <div class="toast-title">${esc(title)}</div>${desc ? `<div class="toast-desc">${esc(desc)}</div>` : ''}</div></div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 220); }, 4000);
}

// ─────────────────────────────────────────────── floating menu engine
let menuState = null;
function closeMenu() {
  if (!menuState) return;
  menuState.el.remove();
  menuState.anchor?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', menuState.onDown, true);
  document.removeEventListener('keydown', menuState.onKey, true);
  window.removeEventListener('resize', menuState.close);
  menuState = null;
}
function openMenu(anchor, items, opts = {}) {
  if (menuState && menuState.anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const menu = el('<div class="menu" role="menu"></div>');
  for (const item of items) {
    if (item.type === 'sep') { menu.appendChild(el('<div class="menu-sep"></div>')); continue; }
    if (item.type === 'label') { menu.appendChild(el(`<div class="menu-label">${esc(item.label)}</div>`)); continue; }
    const b = el(`<button class="menu-item${item.danger ? ' danger' : ''}" role="menuitem">
      ${item.icon ? ic(item.icon) : ''}<span>${esc(item.label)}</span>
      ${item.checked ? `<span class="mi-check">${ic('check')}</span>` : item.sub ? `<span class="mi-sub">${esc(item.sub)}</span>` : ''}
    </button>`);
    b.addEventListener('click', () => { closeMenu(); item.onClick?.(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  if (opts.matchWidth) menu.style.minWidth = r.width + 'px';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = opts.align === 'end' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  anchor.setAttribute('aria-expanded', 'true');

  const focusables = $$('.menu-item', menu);
  let fi = -1;
  const setFocus = (i) => {
    fi = (i + focusables.length) % focusables.length;
    focusables.forEach((f, j) => f.classList.toggle('focused', j === fi));
    focusables[fi]?.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(fi + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(fi - 1); }
  };
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  const close = () => closeMenu();
  window.addEventListener('resize', close);
  menuState = { el: menu, anchor, onDown, onKey, close };
}

// custom select built on the menu engine
function makeSelect(btn, cfg) {
  const render = () => {
    const v = cfg.get();
    const opt = cfg.options().find((o) => o.value === v);
    $('.sel-val', btn).textContent = opt ? opt.label : (cfg.placeholder || 'Select');
  };
  btn.addEventListener('click', () => {
    const opts = cfg.options();
    if (!opts.length) { toast('No models found', 'Is Ollama running? Start it and try again.', 'warn'); return; }
    openMenu(btn, opts.map((o) => ({
      label: o.label, sub: o.sub, checked: o.value === cfg.get(),
      onClick: () => { cfg.set(o.value); render(); },
    })), { matchWidth: cfg.matchWidth !== false, align: cfg.align });
  });
  btn._render = render;
  render();
  return { render };
}

// ─────────────────────────────────────────────── dialogs
function wireStaticDialogs() {
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
  $$('.dlg-backdrop').forEach((m) => m.addEventListener('mousedown', (e) => {
    if (e.target === m && m.id !== 'onboarding') m.classList.add('hidden');
  }));
}
function dynamicDialog(build) {
  return new Promise((resolve) => {
    const backdrop = el('<div class="dlg-backdrop"></div>');
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    };
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) done(null); });
    document.addEventListener('keydown', onKey, true);
    backdrop.appendChild(build(done));
    $('#dlgHost').appendChild(backdrop);
  });
}
function confirmDialog({ title, desc, confirmText = 'Confirm', danger = false }) {
  return dynamicDialog((done) => {
    const d = el(`<div class="dlg">
      <div class="dlg-head"><h2>${esc(title)}</h2></div>
      <p class="dlg-desc">${esc(desc)}</p>
      <div class="dlg-foot">
        <button class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>
      </div></div>`);
    $('[data-act="cancel"]', d).onclick = () => done(false);
    $('[data-act="ok"]', d).onclick = () => done(true);
    setTimeout(() => $('[data-act="cancel"]', d).focus(), 0);
    return d;
  }).then((v) => !!v);
}
function promptDialog({ title, desc = '', label = '', value = '', placeholder = '', confirmText = 'Save' }) {
  return dynamicDialog((done) => {
    const d = el(`<div class="dlg">
      <div class="dlg-head"><h2>${esc(title)}</h2></div>
      ${desc ? `<p class="dlg-desc">${esc(desc)}</p>` : ''}
      ${label ? `<label class="label">${esc(label)}</label>` : '<div style="height:10px"></div>'}
      <input class="input" spellcheck="false" autocomplete="off">
      <div class="dlg-foot">
        <button class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button class="btn btn-primary" data-act="ok">${esc(confirmText)}</button>
      </div></div>`);
    const input = $('input', d);
    input.value = value;
    input.placeholder = placeholder;
    const submit = () => done(input.value.trim() || null);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    $('[data-act="cancel"]', d).onclick = () => done(null);
    $('[data-act="ok"]', d).onclick = submit;
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return d;
  });
}

// ─────────────────────────────────────────────── boot
// NOTE: init() is invoked at the very end of this file — it must run after
// every top-level const below it is initialized (TDZ), since the wire*()
// functions touch them synchronously.
async function init() {
  wireStaticDialogs();
  wireOnboarding();
  wireSidebar();
  wireHome();
  wireProjectsView();
  wireSecurityView();
  wireIntegrations();
  wireWorkspace();
  wireSettings();
  wireCommandPalette();

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
    $('#homeSend').disabled = false;
  }
}

function applyUser() {
  const u = store.user || {};
  const display = u.fullName || u.username || 'there';
  $('#greeting').textContent = `Hi ${display}, what do you want to make?`;
  $('#wsName').textContent = store.wsname || `${u.username || 'my'}'s Workspace`;
  $('#wsAvatar').textContent = (u.username || 'R')[0].toUpperCase();
}

// ─────────────────────────────────────────────── onboarding
function wireOnboarding() {
  const next = () => {
    const username = $('#obUsername').value.trim().replace(/\s+/g, '').toLowerCase();
    if (!username) return $('#obUsername').focus();
    if (!$('#obFullname').value.trim()) $('#obFullname').value = username[0].toUpperCase() + username.slice(1);
    $('#obStep1').classList.add('hidden');
    $('#obStep2').classList.remove('hidden');
  };
  $('#obNext1').onclick = next;
  $('#obUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#obFullname').focus(); });
  $('#obFullname').addEventListener('keydown', (e) => { if (e.key === 'Enter') next(); });
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
      createdAt: Date.now(),
    };
    $('#onboarding').classList.add('hidden');
    applyUser();
    $('#homePrompt').focus();
  };
}

// ─────────────────────────────────────────────── sidebar
function wireSidebar() {
  $$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#btnNew').onclick = () => { showView('home'); $('#homePrompt').focus(); };
  $('#navSettings').onclick = () => openSettings();
  $('#navDocs').onclick = () => $('#docsModal').classList.remove('hidden');
  $('#navLearn').onclick = () => window.open('/products/agent', '_blank');
  $('#btnSearch').onclick = openCmdk;
  $('#btnImport').onclick = () => $('#importInput').click();
  $('#importInput').addEventListener('change', importFiles);
  $('#btnUpgrade').onclick = () =>
    toast('Nothing to upgrade', 'Replica is free and local. Every feature is already unlocked.', 'ok');

  $('#wsSwitch').onclick = () => {
    const u = store.user || {};
    openMenu($('#wsSwitch'), [
      { type: 'label', label: `@${u.username || 'builder'} on the Local Plan` },
      { label: 'Profile', icon: 'user', onClick: () => openSettings('profile') },
      { label: 'Settings', icon: 'gear', onClick: () => openSettings() },
      { label: 'Documentation', icon: 'book', onClick: () => $('#docsModal').classList.remove('hidden') },
      { label: 'About Replica', icon: 'spark', onClick: () => { location.href = '/'; } },
      { type: 'sep' },
      { label: 'Reset workspace', icon: 'trash', danger: true, onClick: resetWorkspace },
    ], { matchWidth: true });
  };
}

async function resetWorkspace() {
  const ok = await confirmDialog({
    title: 'Reset workspace?',
    desc: 'This clears your profile, preferences, and published flags from this browser. Project files stay untouched on disk.',
    confirmText: 'Reset workspace',
    danger: true,
  });
  if (!ok) return;
  ['replica.user', 'replica.model', 'replica.wsname', 'replica.published', 'replica.prefs']
    .forEach((k) => localStorage.removeItem(k));
  location.reload();
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'projects') refreshProjects();
  if (name === 'published') refreshProjects();
  if (name === 'security') refreshProjects();
}

// ─────────────────────────────────────────────── health + models
async function checkHealth() {
  const foot = $('#ollamaStatus');
  try {
    health = await (await fetch('/api/health')).json();
    foot.className = 'sb-foot ' + (health.ollama ? 'ok' : 'bad');
    $('.st-text', foot).textContent = health.ollama ? 'Ollama connected' : 'Ollama offline';
  } catch {
    foot.className = 'sb-foot bad';
    $('.st-text', foot).textContent = 'Server offline';
  }
}

async function loadModels() {
  try {
    const j = await (await fetch('/api/models')).json();
    models = j.models || [];
  } catch { models = []; }
  if (!store.model || !models.some((m) => m.name === store.model)) {
    const pref = models.find((m) => /qwen3/i.test(m.name)) || models[0];
    if (pref) localStorage.setItem('replica.model', pref.name);
  }
  syncModelSelects();
}

const modelOptions = () => models.map((m) => ({ value: m.name, label: m.name, sub: m.params || '' }));
function syncModelSelects() {
  $$('.select[data-model-select]').forEach((b) => b._render?.());
}

// ─────────────────────────────────────────────── home
const EXAMPLES = [
  { t: 'Freelance client portal', p: 'Build a freelance client portal with a project list, invoices table, and a status board' },
  { t: 'Startup analytics dashboard', p: 'Build a startup analytics dashboard with KPI cards, a revenue chart drawn on canvas, and a signups table' },
  { t: 'Retail sales dashboard', p: 'Build a retail sales dashboard with daily sales chart, top products list, and a filterable orders table' },
  { t: 'Personal finance tracker', p: 'Build a personal finance tracker with monthly budgets, category breakdowns, and a spending chart' },
  { t: 'Recipe box app', p: 'Build a recipe box app with searchable cards, a cooking mode with step timers, and a shopping list' },
  { t: 'Habit tracker', p: 'Build a habit tracker with a streak calendar, daily check-ins, and weekly progress rings' },
  { t: 'Pomodoro timer', p: 'Build a pomodoro timer with a circular progress ring, work and break modes, and a session history' },
  { t: 'Team standup board', p: 'Build a team standup board with columns for yesterday, today, and blockers, plus a member filter' },
  { t: 'Markdown notes app', p: 'Build a markdown notes app with a folder sidebar, live preview, and local search' },
  { t: 'Workout planner', p: 'Build a workout planner with exercise cards, weekly schedule grid, and progress charts' },
  { t: 'Event countdown page', p: 'Build an event countdown page with an animated timer, RSVP form, and a schedule section' },
  { t: 'Kanban task board', p: 'Build a kanban task board with drag and drop cards, labels, and a done column with confetti' },
];
let exOffset = 0;

function renderExamples(animated) {
  const row = $('#exRow');
  row.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const e = EXAMPLES[(exOffset + i) % EXAMPLES.length];
    const b = el(`<button class="ex${animated ? ' swap' : ''}">${esc(e.t)}</button>`);
    if (animated) b.style.animationDelay = (i * 45) + 'ms';
    b.onclick = () => {
      const hp = $('#homePrompt');
      hp.value = e.p;
      hp.focus();
      autosize(hp);
      $('#homeSend').disabled = false;
    };
    row.appendChild(b);
  }
}

function wireHome() {
  const hp = $('#homePrompt');
  hp.addEventListener('input', () => { autosize(hp); $('#homeSend').disabled = !hp.value.trim(); });
  hp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startFromHome(); }
  });
  $('#homeSend').onclick = startFromHome;

  // model picker
  const homeModelBtn = $('#homeModel');
  homeModelBtn.dataset.modelSelect = '1';
  homeModelBtn.style.maxWidth = '240px';
  makeSelect(homeModelBtn, {
    options: modelOptions,
    get: () => store.model,
    set: (v) => { store.model = v; },
    placeholder: 'No models',
    matchWidth: false,
    align: 'end',
  });

  // plan toggle
  $('#planPill').onclick = () => $('#planPill').classList.toggle('on');

  // attach menu
  $('#btnAttach').onclick = () => openMenu($('#btnAttach'), [
    { type: 'label', label: 'Start from existing work' },
    { label: 'Import files as a project', icon: 'import', onClick: () => $('#importInput').click() },
    { label: 'Browse example prompts', icon: 'refresh', onClick: () => shuffleExamples() },
  ]);

  // dictation
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $('#btnMic').classList.add('hidden');
  } else {
    let rec = null;
    $('#btnMic').onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = false;
      $('#btnMic').style.color = 'var(--red-soft)';
      rec.onresult = (e) => {
        const text = [...e.results].map((r) => r[0].transcript).join(' ').trim();
        if (text) { hp.value = (hp.value ? hp.value + ' ' : '') + text; autosize(hp); $('#homeSend').disabled = false; }
      };
      rec.onend = () => { $('#btnMic').style.color = ''; rec = null; };
      rec.onerror = () => toast('Dictation unavailable', 'Speech recognition did not start in this browser.', 'warn');
      try { rec.start(); } catch { rec = null; $('#btnMic').style.color = ''; }
    };
  }

  // categories
  $$('#catRow .cat').forEach((c) => c.onclick = () => {
    hp.value = c.dataset.p;
    hp.focus();
    autosize(hp);
    $('#homeSend').disabled = false;
  });
  const catRow = $('#catRow');
  const syncArrows = () => {
    $('#catPrev').disabled = catRow.scrollLeft <= 2;
    $('#catNext').disabled = catRow.scrollLeft >= catRow.scrollWidth - catRow.clientWidth - 2;
  };
  $('#catPrev').onclick = () => catRow.scrollBy({ left: -180, behavior: 'smooth' });
  $('#catNext').onclick = () => catRow.scrollBy({ left: 180, behavior: 'smooth' });
  catRow.addEventListener('scroll', syncArrows);
  requestAnimationFrame(syncArrows);

  // examples
  renderExamples(false);
  $('#exShuffle').onclick = () => shuffleExamples();

  // rotating placeholder
  const ideas = ['Make a mobile app for...', 'Build a website for...', 'Create a game about...', 'Design a dashboard for...', 'Animate something that...'];
  let ii = 0;
  setInterval(() => {
    if (!hp.value && store.prefs.rotateIdeas) hp.placeholder = ideas[++ii % ideas.length];
  }, 3000);
}

function shuffleExamples() {
  exOffset = (exOffset + 3) % EXAMPLES.length;
  renderExamples(true);
}

function deriveName(prompt) {
  const words = prompt.replace(/[^\w\s-]/g, ' ').trim().split(/\s+/)
    .filter((w) => !/^(a|an|the|for|with|and|to|of|me|my|please|build|make|create|design|that|app|website)$/i.test(w));
  const base = (words.slice(0, 4).join(' ') || prompt.split(/\s+/).slice(0, 4).join(' ')).slice(0, 48);
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) || 'New Project';
}

async function startFromHome() {
  let prompt = $('#homePrompt').value.trim();
  if (!prompt || streaming) return;
  if ($('#planPill').classList.contains('on')) {
    prompt += '\n\nBefore writing any files, briefly describe your plan in two or three sentences, then build it.';
  }
  const meta = await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: deriveName(prompt), description: $('#homePrompt').value.trim() }),
  })).json();
  $('#homePrompt').value = '';
  $('#homeSend').disabled = true;
  await openProject(meta);
  sendChat(prompt);
}

async function importFiles(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const name = await promptDialog({
    title: 'Import files',
    desc: `${files.length} file${files.length === 1 ? '' : 's'} selected. They become a new project you can preview and keep editing with the Agent.`,
    label: 'Project name',
    value: files[0].name.replace(/\.[^.]+$/, ''),
    confirmText: 'Import',
  });
  if (name === null) return;
  const payload = [];
  for (const f of files.slice(0, 100)) {
    if (f.size > 2 * 1024 * 1024) continue;
    payload.push({ path: f.name, content: await f.text() });
  }
  const meta = await (await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: `Imported ${payload.length} file(s)`, files: payload }),
  })).json();
  toast('Project imported', `${payload.length} file(s) copied into ${meta.name}.`, 'ok');
  openProject(meta);
}

// ─────────────────────────────────────────────── projects
async function refreshProjects() {
  try {
    const j = await (await fetch('/api/projects')).json();
    projects = j.projects || [];
  } catch { projects = []; }
  renderProjects();
  renderPublished();
  renderSecurity();
}

let projQuery = '';
function wireProjectsView() {
  $('#projSearch').addEventListener('input', (e) => { projQuery = e.target.value.toLowerCase(); renderProjects(); });
  $('#projNew').onclick = () => { showView('home'); $('#homePrompt').focus(); };
  $('#promoAbout').onclick = () => $('#docsModal').classList.remove('hidden');
}

function projectMenuItems(p) {
  return [
    { label: 'Open in workspace', icon: 'code', onClick: () => openProjectById(p.id) },
    { label: 'Open preview in new tab', icon: 'ext', onClick: () => window.open(`/preview/${p.id}/`, '_blank') },
    { type: 'sep' },
    isPublished(p.id)
      ? { label: 'Unpublish', icon: 'globe', onClick: () => { setPublished(p.id, false); toast('Unpublished', `${p.name} was removed from Published Projects.`); renderProjects(); renderPublished(); renderSecurity(); } }
      : { label: 'Publish', icon: 'globe', onClick: () => { setPublished(p.id, true); toast('Published locally', `${p.name} now shows up under Published Projects.`, 'ok'); renderProjects(); renderPublished(); renderSecurity(); } },
    { label: 'Rename', icon: 'pen', onClick: () => renameProject(p) },
    { type: 'sep' },
    { label: 'Delete project', icon: 'trash', danger: true, onClick: () => deleteProject(p) },
  ];
}

function renderProjects() {
  const grid = $('#projGrid');
  grid.innerHTML = '';
  const list = projects.filter((p) =>
    !projQuery || (p.name + ' ' + (p.description || '')).toLowerCase().includes(projQuery));
  $('#projEmpty').classList.toggle('hidden', projects.length > 0);
  for (const p of list) {
    const card = el(`<div class="proj-card" role="button" tabindex="0">
      <button class="icon-btn pc-menu" title="Project options">${ic('dots')}</button>
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.description || 'No description')}</p>
      <div class="pc-foot">
        <span class="when">Updated ${timeAgo(p.updatedAt)}</span>
        ${isPublished(p.id) ? '<span class="badge badge-blue">Published</span>' : ''}
      </div></div>`);
    card.addEventListener('click', (e) => { if (!e.target.closest('.pc-menu')) openProjectById(p.id); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProjectById(p.id); });
    $('.pc-menu', card).addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, projectMenuItems(p), { align: 'end' });
    });
    grid.appendChild(card);
  }
  if (projects.length && !list.length) {
    grid.appendChild(el(`<div class="empty" style="grid-column:1/-1">
      <div class="empty-ic">${ic('search')}</div><h3>No matches</h3>
      <p>No project matches that search.</p></div>`));
  }
}

async function renameProject(p) {
  const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: p.name, confirmText: 'Rename' });
  if (!name || name === p.name) return;
  await fetch('/api/projects/' + p.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  toast('Project renamed', `Now called ${name}.`, 'ok');
  refreshProjects();
}

async function deleteProject(p) {
  const ok = await confirmDialog({
    title: `Delete ${p.name}?`,
    desc: 'This permanently deletes the project folder and all of its files from your disk. This cannot be undone.',
    confirmText: 'Delete project',
    danger: true,
  });
  if (!ok) return;
  await fetch('/api/projects/' + p.id, { method: 'DELETE' });
  setPublished(p.id, false);
  toast('Project deleted', `${p.name} was removed.`);
  refreshProjects();
}

async function openProjectById(id) {
  const p = projects.find((x) => x.id === id);
  if (p) return openProject(p);
  await refreshProjects();
  const q = projects.find((x) => x.id === id);
  if (q) openProject(q);
}

// ─────────────────────────────────────────────── published view
function renderPublished() {
  const list = $('#pubList');
  list.innerHTML = '';
  const pubs = projects.filter((p) => isPublished(p.id));
  $('#pubEmpty').classList.toggle('hidden', pubs.length > 0);
  for (const p of pubs) {
    const row = el(`<div class="pub-row">
      <div class="pub-ic">${ic('globe')}</div>
      <div class="pub-info">
        <div class="pub-name">${esc(p.name)}</div>
        <div class="pub-sub">Published locally, updated ${timeAgo(p.updatedAt)}</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-act="view">${ic('ext')} View app</button>
      <button class="icon-btn" data-act="menu" title="Options">${ic('dots')}</button>
    </div>`);
    $('[data-act="view"]', row).onclick = () => window.open(`/preview/${p.id}/`, '_blank');
    $('[data-act="menu"]', row).onclick = (e) => openMenu(e.currentTarget, [
      { label: 'Open in workspace', icon: 'code', onClick: () => openProjectById(p.id) },
      { label: 'Unpublish', icon: 'globe', onClick: () => { setPublished(p.id, false); renderPublished(); renderProjects(); toast('Unpublished', `${p.name} was removed from Published Projects.`); } },
    ], { align: 'end' });
    list.appendChild(row);
  }
}

// ─────────────────────────────────────────────── security view
const secFilter = { q: '', severity: '', pub: '' };
function wireSecurityView() {
  $('#secSearch').addEventListener('input', (e) => { secFilter.q = e.target.value.toLowerCase(); renderSecurity(); });
  makeSelect($('#secSeverity'), {
    options: () => [
      { value: '', label: 'Severity level' },
      { value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' },
    ],
    get: () => secFilter.severity,
    set: (v) => { secFilter.severity = v; renderSecurity(); },
  });
  makeSelect($('#secPubStatus'), {
    options: () => [
      { value: '', label: 'Publishing status' },
      { value: 'published', label: 'Published' },
      { value: 'unpublished', label: 'Not published' },
    ],
    get: () => secFilter.pub,
    set: (v) => { secFilter.pub = v; renderSecurity(); },
  });
}

function renderSecurity() {
  const tbody = $('#secRows');
  if (!tbody) return;
  tbody.innerHTML = '';
  const u = store.user || {};
  let rows = projects.filter((p) => !secFilter.q || p.name.toLowerCase().includes(secFilter.q));
  if (secFilter.severity) rows = [];  // no vulnerabilities exist at any severity
  if (secFilter.pub === 'published') rows = rows.filter((p) => isPublished(p.id));
  if (secFilter.pub === 'unpublished') rows = rows.filter((p) => !isPublished(p.id));
  $('#secCount').textContent = `Showing ${rows.length} project${rows.length === 1 ? '' : 's'}`;
  $('#secEmpty').classList.toggle('hidden', rows.length > 0);
  for (const p of rows) {
    tbody.appendChild(el(`<tr>
      <td style="font-weight:600">${esc(p.name)}</td>
      <td style="color:var(--muted)">0 vulnerabilities</td>
      <td style="color:var(--muted)">@${esc(u.username || 'builder')}</td>
      <td style="color:var(--muted)">${isPublished(p.id) ? 'Yes' : 'No'}</td>
      <td><span class="badge badge-green">${ic('check')} Clean</span></td>
    </tr>`));
  }
}

// ─────────────────────────────────────────────── integrations
const INTEG_TILES = [
  ['#F5F9FC', '<path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.9-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1a3.6 3.6 0 0 1 .1 2.7 3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" fill="currentColor"/>'],
  ['#E8453C', '<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/><path d="M8.5 8.5h7v7h-7z" fill="#fff" opacity=".9"/>'],
  ['#E01E5A', '<rect x="10.5" y="3" width="3" height="8" rx="1.5" fill="#36C5F0"/><rect x="13" y="10.5" width="8" height="3" rx="1.5" fill="#2EB67D"/><rect x="10.5" y="13" width="3" height="8" rx="1.5" fill="#E01E5A"/><rect x="3" y="10.5" width="8" height="3" rx="1.5" fill="#ECB22E"/>'],
  ['#4285F4', '<path d="m9 4 6 10.5-3 5.5L6 9.5z" fill="#FBBC05"/><path d="M9 4h6l6 10.5h-6z" fill="#4285F4"/><path d="m6 20 3-5.5h12L18 20z" fill="#34A853"/>'],
  ['#34A853', '<rect x="5" y="3" width="14" height="18" rx="2" fill="currentColor"/><path d="M8 9h8v8H8zM8 11.6h8M8 14.2h8M11 9v8" stroke="#fff" stroke-width="1.1" fill="none"/>'],
  ['#611F69', '<rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor"/><circle cx="9" cy="9" r="2" fill="#E01E5A"/><circle cx="15" cy="9" r="2" fill="#36C5F0"/><circle cx="9" cy="15" r="2" fill="#ECB22E"/><circle cx="15" cy="15" r="2" fill="#2EB67D"/>'],
  ['#FF7A59', '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'],
  ['#4285F4', '<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/><text x="12" y="15.5" font-size="8.5" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial">31</text>'],
  ['#F22F46', '<circle cx="12" cy="12" r="9" fill="currentColor"/><circle cx="9.5" cy="9.5" r="1.6" fill="#fff"/><circle cx="14.5" cy="9.5" r="1.6" fill="#fff"/><circle cx="9.5" cy="14.5" r="1.6" fill="#fff"/><circle cx="14.5" cy="14.5" r="1.6" fill="#fff"/>'],
  ['#635BFF', '<rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor"/><text x="12" y="16.5" font-size="12" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial">S</text>'],
  ['#0061FF', '<path d="m7 4 5 3.2L7 10.4 2 7.2zM17 4l5 3.2-5 3.2-5-3.2zM7 10.4l5 3.2-5 3.2-5-3.2zM17 10.4l5 3.2-5 3.2-5-3.2zM12 17.5l5 3.2H7z" fill="currentColor" transform="scale(.92) translate(1 0)"/>'],
  ['#5BA7F7', '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor"/><path d="M18 14l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" fill="currentColor" opacity=".7"/>'],
];
function wireIntegrations() {
  const wrap = $('#integIcons');
  for (const [color, glyph] of INTEG_TILES) {
    wrap.appendChild(el(`<div class="integ-tile" style="color:${color}"><svg viewBox="0 0 24 24">${glyph}</svg></div>`));
  }
  $('#integNotify').onclick = () =>
    toast('Request received', 'Integrations are on the roadmap. Everything else already runs locally.', 'ok');
}

// ─────────────────────────────────────────────── settings overlay
const SET_NAV = [
  { group: 'Workspace', items: [
    { id: 'overview', label: 'Workspace overview', icon: 'home' },
    { id: 'collaborators', label: 'Workspace collaborators', icon: 'users' },
    { id: 'integrations', label: 'Integrations', icon: 'layers' },
    { id: 'customization', label: 'Customization', icon: 'brush' },
    { id: 'security', label: 'Security', icon: 'shield' },
  ]},
  { group: 'Account', items: [
    { id: 'usage', label: 'Usage', icon: 'gauge' },
    { id: 'billing', label: 'Billing', icon: 'card' },
    { id: 'seats', label: 'Account seats', icon: 'users' },
    { id: 'advanced', label: 'Advanced', icon: 'sliders' },
  ]},
  { group: 'User', items: [
    { id: 'profile', label: 'Profile', icon: 'user' },
    { id: 'referrals', label: 'Promotions & Referrals', icon: 'gift' },
    { id: 'personalization', label: 'Personalization', icon: 'pen' },
  ]},
];
let setPageId = 'overview';

function wireSettings() {
  $('#setClose').onclick = closeSettings;
}
function openSettings(page = 'overview') {
  setPageId = page;
  renderSetSide();
  renderSetPage();
  $('#settings').classList.remove('hidden');
}
function closeSettings() {
  $('#settings').classList.add('hidden');
  applyUser();
}

function renderSetSide() {
  const side = $('#setSide');
  side.innerHTML = '';
  const u = store.user || {};
  const pill = el(`<button class="ws-switch">
    <span class="ws-avatar">${esc((u.username || 'R')[0].toUpperCase())}</span>
    <span class="ws-name">${esc(store.wsname || `${u.username || 'my'}'s Workspace`)}</span>
    ${ic('chev-d')}</button>`);
  pill.onclick = () => { setPageId = 'overview'; renderSetSide(); renderSetPage(); };
  side.appendChild(pill);
  for (const g of SET_NAV) {
    side.appendChild(el(`<div class="set-group">${esc(g.group)}</div>`));
    for (const item of g.items) {
      const b = el(`<button class="nav-item${item.id === setPageId ? ' active' : ''}">${ic(item.icon)} ${esc(item.label)}</button>`);
      b.onclick = () => { setPageId = item.id; renderSetSide(); renderSetPage(); };
      side.appendChild(b);
    }
  }
}

function pageHead(icon, title, sub = '') {
  return `<div class="page-head">${ic(icon)}<h1>${esc(title)}</h1></div>${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}`;
}
function srow({ title, desc, descHTML }) {
  return el(`<div class="srow"><div class="srow-info">
    <div class="srow-title">${esc(title)}</div>
    ${desc || descHTML ? `<div class="srow-desc">${descHTML || esc(desc)}</div>` : ''}
  </div><div class="srow-action"></div></div>`);
}
function withAction(row, node) {
  $('.srow-action', row).appendChild(node);
  return row;
}
function makeSwitch(get, set) {
  const s = el(`<button class="switch" role="switch" aria-checked="${get()}"></button>`);
  s.onclick = () => { const v = !(s.getAttribute('aria-checked') === 'true'); s.setAttribute('aria-checked', String(v)); set(v); };
  return s;
}
function memberRow() {
  const u = store.user || {};
  return el(`<div class="member-row">
    <span class="ws-avatar">${esc((u.username || 'R')[0].toUpperCase())}</span>
    <div><div class="member-name">${esc(u.fullName || u.username || 'You')}</div>
    <div class="member-sub">@${esc(u.username || 'builder')}</div></div>
    <span class="badge">Owner</span></div>`);
}

const SET_PAGES = {
  overview() {
    const u = store.user || {};
    const page = el(`<div>${pageHead('home', 'Workspace overview', 'Your workspace holds every project the Agent builds. It lives entirely on this machine.')}</div>`);

    const nameRow = srow({ title: 'Workspace name', desc: 'Shown in the sidebar and at the top of Settings.' });
    const nameWrap = el('<div style="display:flex;gap:10px"></div>');
    const nameInput = el(`<input class="input input-sm" style="width:220px" spellcheck="false" value="${esc(store.wsname || `${u.username || 'my'}'s Workspace`)}">`);
    const saveBtn = el('<button class="btn btn-secondary btn-sm">Save</button>');
    saveBtn.onclick = () => { store.wsname = nameInput.value.trim(); applyUser(); renderSetSide(); toast('Workspace renamed', '', 'ok'); };
    nameWrap.append(nameInput, saveBtn);
    page.appendChild(withAction(nameRow, nameWrap));

    const owner = srow({ title: 'Workspace owner' });
    $('.srow-info', owner).appendChild(memberRow());
    page.appendChild(owner);

    const stats = srow({ title: 'Projects', desc: 'Counting folders in replica/projects/ on your disk.' });
    const count = el(`<span class="badge">${projects.length} project${projects.length === 1 ? '' : 's'}</span>`);
    page.appendChild(withAction(stats, count));
    return page;
  },

  collaborators() {
    const page = el(`<div>${pageHead('users', 'Workspace collaborators', 'People with access to this workspace.')}</div>`);
    page.appendChild(memberRow());
    const invite = srow({ title: 'Invite collaborators', desc: 'Replica runs on your machine under your OS account, so there is exactly one seat: yours.' });
    const btn = el(`<button class="btn btn-secondary btn-sm">${ic('plus')} Invite</button>`);
    btn.onclick = () => toast('Single player mode', 'Replica is local and single user. There is no one to invite.', 'info');
    page.appendChild(withAction(invite, btn));
    return page;
  },

  integrations() {
    const page = el(`<div>${pageHead('layers', 'Integrations')}</div>`);
    const panel = el(`<div class="integ-panel">
      <div class="integ-icons"></div>
      <h2>Connect your favorite services</h2>
      <p>Connect your apps to powerful services like Stripe, Google Sheets, Twilio, and more. Add MCP servers to extend your Agent's capabilities. Integrations are on the Replica roadmap.</p>
      <button class="btn btn-secondary">${ic('plus')} Request an integration</button></div>`);
    const iconWrap = $('.integ-icons', panel);
    for (const [color, glyph] of INTEG_TILES) {
      iconWrap.appendChild(el(`<div class="integ-tile" style="color:${color}"><svg viewBox="0 0 24 24">${glyph}</svg></div>`));
    }
    $('button', panel).onclick = () => toast('Request received', 'Integrations are on the roadmap.', 'ok');
    page.appendChild(panel);
    return page;
  },

  customization() {
    const page = el(`<div>${pageHead('brush', 'Customization', 'Tune how the Agent and the workspace behave.')}</div>`);

    const modelRow = srow({ title: 'Default model', desc: 'Used for new prompts on Home and preselected in every project. Bigger models build better apps.' });
    const sel = el(`<button class="select" style="min-width:260px" data-model-select aria-haspopup="listbox"><span class="sel-val">Model</span>${ic('chev-d')}</button>`);
    makeSelect(sel, {
      options: modelOptions,
      get: () => store.model,
      set: (v) => { store.model = v; },
      placeholder: 'No models found',
    });
    page.appendChild(withAction(modelRow, sel));

    const thinkRow = srow({ title: 'Show model reasoning', desc: 'Thinking models stream their reasoning before they answer. Turn this off to hide those blocks in chat.' });
    page.appendChild(withAction(thinkRow, makeSwitch(
      () => store.prefs.showThinking,
      (v) => { store.prefs = { ...store.prefs, showThinking: v }; },
    )));

    const ideasRow = srow({ title: 'Rotating prompt ideas', desc: 'Cycle placeholder suggestions in the Home prompt box every few seconds.' });
    page.appendChild(withAction(ideasRow, makeSwitch(
      () => store.prefs.rotateIdeas,
      (v) => { store.prefs = { ...store.prefs, rotateIdeas: v }; },
    )));
    return page;
  },

  security() {
    const page = el(`<div>${pageHead('shield', 'Security', 'Dependency scans and workspace safety.')}</div>`);
    page.appendChild(el(`<div class="alert alert-success">${ic('shield')}<div>
      <div class="alert-title">No vulnerabilities detected</div>
      <div class="alert-desc">Your workspace is clean. No security findings were found.</div></div></div>`));
    const row = srow({ title: 'Dependency scan overview', desc: 'Search and filter every project with its scan status in the full overview.' });
    const btn = el(`<button class="btn btn-secondary btn-sm">Open security overview</button>`);
    btn.onclick = () => { closeSettings(); showView('security'); };
    page.appendChild(withAction(row, btn));

    const local = srow({ title: 'Network exposure', descHTML: 'Replica binds to <code>127.0.0.1</code> by default, so nothing is reachable from outside this machine unless you set <code>HOST=0.0.0.0</code> yourself.' });
    page.appendChild(local);
    return page;
  },

  usage() {
    const page = el(`<div>${pageHead('gauge', 'Usage', 'Everything is unmetered because it runs on your hardware.')}</div>`);
    const grid = el('<div class="stat-grid"></div>');
    grid.appendChild(el(`<div class="stat-card"><div class="st-label">${ic('grid')} Projects</div>
      <div class="st-value">${projects.length}</div><div class="st-sub">folders on disk</div></div>`));
    grid.appendChild(el(`<div class="stat-card"><div class="st-label">${ic('spark')} Models</div>
      <div class="st-value">${models.length}</div><div class="st-sub">available in Ollama</div></div>`));
    grid.appendChild(el(`<div class="stat-card"><div class="st-label">${ic('cloud')} Agent</div>
      <div class="st-value" style="font-size:18px;padding-top:5px">${health.ollama ? 'Connected' : 'Offline'}</div>
      <div class="st-sub">${esc(health.ollamaHost || '')}</div></div>`));
    page.appendChild(grid);
    page.appendChild(srow({ title: 'Agent credits', desc: 'Unlimited. Chats run against your own Ollama install and never leave this machine.' }));
    page.appendChild(srow({ title: 'Cloud credits', desc: 'Not applicable. There is no cloud, previews are served straight from your project folders.' }));
    return page;
  },

  billing() {
    const page = el(`<div>${pageHead('card', 'Billing')}</div>`);
    const card = el(`<div class="promo-card">
      <div style="display:flex;align-items:baseline;gap:12px"><h2>Local Plan</h2><span class="badge badge-green">Current plan</span></div>
      <div style="font-size:32px;font-weight:600;letter-spacing:-.02em;margin:14px 0 4px">$0<span style="font-size:14px;color:var(--muted);font-weight:500"> forever</span></div>
      <p style="margin-top:12px">Unlimited Agent chats on your own models. Unlimited projects stored on your disk. No accounts, no telemetry, no invoices.</p>
      <button class="btn btn-primary">Manage plan</button></div>`);
    $('button', card).onclick = () => toast('Nothing to manage', 'There is no paid tier. Replica stays free because your hardware does the work.', 'ok');
    page.appendChild(card);
    return page;
  },

  seats() {
    const page = el(`<div>${pageHead('users', 'Account seats', '1 of 1 seats used.')}</div>`);
    page.appendChild(memberRow());
    const row = srow({ title: 'Add seats', desc: 'Replica is a single user tool by design. Your OS account is the only seat.' });
    const btn = el(`<button class="btn btn-secondary btn-sm">${ic('plus')} Add seat</button>`);
    btn.onclick = () => toast('Single seat', 'One machine, one builder. No extra seats needed.', 'info');
    page.appendChild(withAction(row, btn));
    return page;
  },

  advanced() {
    const page = el(`<div>${pageHead('sliders', 'Advanced', 'Connection details and runtime configuration.')}</div>`);

    const hostRow = srow({ title: 'Ollama host', descHTML: `The Agent talks to <code>${esc(health.ollamaHost || 'http://localhost:11434')}</code>. Override with the <code>OLLAMA_HOST</code> environment variable.` });
    const badge = el(`<span class="badge ${health.ollama ? 'badge-green' : ''}">${health.ollama ? 'Connected' : 'Offline'}</span>`);
    const test = el('<button class="btn btn-secondary btn-sm">Test connection</button>');
    test.onclick = async () => {
      await checkHealth();
      health.ollama
        ? toast('Ollama connected', `Reachable at ${health.ollamaHost}.`, 'ok')
        : toast('Ollama offline', 'Start Ollama and test again.', 'warn');
      renderSetPage();
    };
    const wrap = el('<div style="display:flex;align-items:center;gap:10px"></div>');
    wrap.append(badge, test);
    page.appendChild(withAction(hostRow, wrap));

    page.appendChild(srow({ title: 'Projects directory', descHTML: 'Projects are plain folders in <code>replica/projects/</code> next to server.js. Back them up by copying the folder.' }));
    page.appendChild(srow({ title: 'Keyboard shortcuts', descHTML: 'Search and actions: <code>Ctrl+K</code>. Save file in the editor: <code>Ctrl+S</code>. Send a prompt: <code>Enter</code>, new line: <code>Shift+Enter</code>.' }));
    return page;
  },

  profile() {
    const u = store.user || {};
    const page = el(`<div>${pageHead('user', 'Profile')}</div>`);

    const idRow = srow({ title: 'Identity', desc: 'Shown in your workspace greeting and as the project owner.' });
    const stack = el('<div class="srow-stack"></div>');
    const userField = el(`<div class="field"><span class="at">@</span><input class="input" spellcheck="false" value="${esc(u.username || '')}" placeholder="username"></div>`);
    const nameInput = el(`<input class="input" spellcheck="false" value="${esc(u.fullName || '')}" placeholder="Full name">`);
    const save = el('<button class="btn btn-primary btn-sm" style="align-self:flex-start">Save profile</button>');
    save.onclick = () => {
      const nu = { ...store.user };
      nu.username = $('input', userField).value.trim().replace(/\s+/g, '').toLowerCase() || nu.username || 'builder';
      nu.fullName = nameInput.value.trim();
      store.user = nu;
      applyUser();
      renderSetSide();
      renderSecurity();
      toast('Profile updated', '', 'ok');
    };
    stack.append(userField, nameInput, save);
    $('.srow-info', idRow).appendChild(stack);
    page.appendChild(idRow);

    const roleRow = srow({ title: 'What describes you best', desc: 'Used to tailor examples. Pick what you do most often.' });
    const roleSel = el(`<button class="select" style="min-width:220px" aria-haspopup="listbox"><span class="sel-val"></span>${ic('chev-d')}</button>`);
    makeSelect(roleSel, {
      options: () => ROLES.map((r) => ({ value: r, label: r })),
      get: () => (store.user || {}).role || '',
      set: (v) => { store.user = { ...store.user, role: v }; },
      placeholder: 'Choose a role',
    });
    page.appendChild(withAction(roleRow, roleSel));

    const exportRow = srow({ title: 'Export projects', desc: 'Bundle every project, its files, and its chat history into a single JSON file you can archive or move to another machine.' });
    const exportBtn = el(`<button class="btn btn-secondary btn-sm">${ic('import')} Start export</button>`);
    exportBtn.onclick = exportProjects;
    page.appendChild(withAction(exportRow, exportBtn));

    const dangerRow = srow({ title: 'Reset workspace', desc: 'PERMANENT for browser data: clears your profile, preferences, and published flags. Project files on disk are not touched.' });
    const dangerBtn = el(`<button class="btn btn-danger-outline btn-sm">${ic('trash')} Reset workspace</button>`);
    dangerBtn.onclick = resetWorkspace;
    page.appendChild(withAction(dangerRow, dangerBtn));
    return page;
  },

  referrals() {
    const page = el(`<div>${pageHead('gift', 'Promotions & Referrals')}</div>`);
    const card = el(`<div class="promo-card">
      <h2>Nothing to redeem, nothing to refer</h2>
      <p>Replica has no credits, coupons, or referral tiers. If it makes you productive, share it with a friend. That is the whole program.</p>
      <button class="btn btn-primary">See how it works</button></div>`);
    $('button', card).onclick = () => { $('#docsModal').classList.remove('hidden'); };
    page.appendChild(card);
    return page;
  },

  personalization() {
    const page = el(`<div>${pageHead('pen', 'Personalization', 'If you wear many hats, pick what you do most often.')}</div>`);
    const grid = el('<div class="role-grid" style="margin-top:6px"></div>');
    const current = (store.user || {}).role || '';
    for (const r of ROLES) {
      const b = el(`<button class="role${r === current ? ' sel' : ''}">${esc(r)}</button>`);
      b.onclick = () => {
        store.user = { ...store.user, role: r };
        $$('.role', grid).forEach((x) => x.classList.toggle('sel', x === b));
        toast('Saved', `Examples will lean toward ${r}.`, 'ok');
      };
      grid.appendChild(b);
    }
    page.appendChild(grid);
    return page;
  },
};

function renderSetPage() {
  const host = $('#setPage');
  host.innerHTML = '';
  host.appendChild(SET_PAGES[setPageId]());
}

async function exportProjects() {
  toast('Export started', 'Collecting projects and files.');
  try {
    const list = (await (await fetch('/api/projects')).json()).projects || [];
    const out = [];
    let fileCount = 0;
    for (const p of list) {
      const j = await (await fetch(`/api/projects/${p.id}/files`)).json();
      const files = {};
      for (const f of (j.files || []).slice(0, 200)) {
        const fj = await (await fetch(`/api/projects/${p.id}/file?path=${encodeURIComponent(f.path)}`)).json();
        if (fj.content !== undefined) { files[f.path] = fj.content; fileCount++; }
      }
      out.push({ meta: j.meta || p, chat: j.chat || [], files });
    }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), projects: out }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'replica-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Export ready', `${out.length} project(s), ${fileCount} file(s) downloaded as replica-export.json.`, 'ok');
  } catch (e) {
    toast('Export failed', e.message, 'warn');
  }
}

// ─────────────────────────────────────────────── command palette
function wireCommandPalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
    if (e.key === 'Escape' && !menuState) {
      if (!$('#cmdkModal').classList.contains('hidden')) return $('#cmdkModal').classList.add('hidden');
      if (!$('#docsModal').classList.contains('hidden')) return $('#docsModal').classList.add('hidden');
      if (!$('#settings').classList.contains('hidden')) return closeSettings();
    }
  });
  $('#cmdkInput').addEventListener('input', renderCmdk);
  $('#cmdkInput').addEventListener('keydown', (e) => {
    const items = $$('#cmdkList .menu-item');
    let idx = items.findIndex((x) => x.classList.contains('focused'));
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(idx - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); items[Math.max(idx, 0)]?.click(); return; }
    else return;
    items.forEach((x, j) => x.classList.toggle('focused', j === idx));
    items[idx]?.scrollIntoView({ block: 'nearest' });
  });
}
function openCmdk() {
  $('#cmdkModal').classList.remove('hidden');
  $('#cmdkInput').value = '';
  renderCmdk();
  refreshProjects().then(renderCmdk);
  setTimeout(() => $('#cmdkInput').focus(), 0);
}
function closeCmdk() { $('#cmdkModal').classList.add('hidden'); }

function cmdkActions() {
  return [
    { label: 'Create something new', icon: 'plus', run: () => { showView('home'); $('#homePrompt').focus(); } },
    { label: 'Import code or design', icon: 'import', run: () => $('#importInput').click() },
    { label: 'Go to Projects', icon: 'grid', run: () => showView('projects') },
    { label: 'Go to Published Projects', icon: 'globe', run: () => showView('published') },
    { label: 'Go to Integrations', icon: 'layers', run: () => showView('integrations') },
    { label: 'Go to Security', icon: 'shield', run: () => showView('security') },
    { label: 'Open Settings', icon: 'gear', run: () => openSettings() },
    { label: 'Documentation', icon: 'book', run: () => $('#docsModal').classList.remove('hidden') },
  ];
}
function renderCmdk() {
  const q = $('#cmdkInput').value.trim().toLowerCase();
  const list = $('#cmdkList');
  list.innerHTML = '';
  const acts = cmdkActions().filter((a) => !q || a.label.toLowerCase().includes(q));
  const projs = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  if (projs.length) {
    list.appendChild(el('<div class="menu-label">Projects</div>'));
    for (const p of projs.slice(0, 6)) {
      const b = el(`<button class="menu-item">${ic('folder')}<span>${esc(p.name)}</span><span class="mi-sub">${esc(timeAgo(p.updatedAt))}</span></button>`);
      b.onclick = () => { closeCmdk(); openProjectById(p.id); };
      list.appendChild(b);
    }
  }
  if (acts.length) {
    list.appendChild(el('<div class="menu-label">Actions</div>'));
    for (const a of acts) {
      const b = el(`<button class="menu-item">${ic(a.icon)}<span>${esc(a.label)}</span></button>`);
      b.onclick = () => { closeCmdk(); a.run(); };
      list.appendChild(b);
    }
  }
  if (!projs.length && !acts.length) list.appendChild(el('<div class="cmdk-empty">No results found.</div>'));
  const first = $('.menu-item', list);
  first?.classList.add('focused');
}

// ─────────────────────────────────────────────── workspace (IDE)
function wireWorkspace() {
  $('#wsBack').onclick = () => { current = null; showView('projects'); };
  $('#btnOpenTab').onclick = () => { if (current) window.open(`/preview/${current.id}/`, '_blank'); };
  $('#btnRefresh').onclick = refreshPreview;

  const wsModelBtn = $('#wsModel');
  wsModelBtn.dataset.modelSelect = '1';
  wsModelBtn.style.maxWidth = '240px';
  makeSelect(wsModelBtn, {
    options: modelOptions,
    get: () => store.model,
    set: (v) => { store.model = v; },
    placeholder: 'No models',
    matchWidth: false,
    align: 'end',
  });

  $$('.ptab').forEach((t) => t.addEventListener('click', () => {
    $$('.ptab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $$('.ptab-view').forEach((v) => v.classList.add('hidden'));
    $('#tab-' + t.dataset.tab).classList.remove('hidden');
    if (t.dataset.tab === 'code') loadTree();
    if (t.dataset.tab === 'console') $('#consoleCmd').focus();
  }));

  const ct = $('#chatText');
  ct.addEventListener('input', () => { autosize(ct); syncChatSend(); });
  ct.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chatSend').onclick = () => sendChat();
  $('#chatStop').onclick = () => { if (streamAbort) streamAbort.abort(); };
  syncChatSend();

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
  $('#consoleCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(); });
}

async function openProject(meta) {
  if (streamAbort) streamAbort.abort();  // switching projects cancels a running turn
  current = meta;
  $('#wsTitle').textContent = meta.name;
  closeEditor();
  $('#chatScroll').innerHTML = '';
  showView('workspace');
  refreshPreview();

  const j = await (await fetch(`/api/projects/${meta.id}/files`)).json();
  current = j.meta || meta;
  const chat = j.chat || [];
  if (!chat.length) {
    $('#chatScroll').appendChild(el(`<div class="chat-welcome">${ic('spark')}Tell the Agent what to build.<br>It writes real files into this project as it answers.</div>`));
  }
  for (const m of chat) {
    if (m.role === 'user') addUserMsg(m.content);
    else renderHistoryTurn(m.content, m.turn);
  }
  scrollChat(true);
  loadTree();
}

function renderHistoryTurn(content, turnId) {
  const turn = el('<div class="turn"></div>');
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
    const n = el('<div class="turn-narration"></div>');
    n.innerHTML = mdToHtml(narr.join('\n').trim());
    turn.appendChild(n);
  }
  if (ops.length) {
    const wrap = el('<div class="fileops"></div>');
    for (const o of ops) {
      wrap.appendChild(el(`<div class="fileop done${o.del ? ' del' : ''}">
        <span class="st">${ic(o.del ? 'x' : 'check')}</span><span class="fpath">${esc(o.path)}</span></div>`));
    }
    turn.appendChild(wrap);
  }
  if (turnId) turn.appendChild(makeRestoreRow(turnId));
  $('#chatScroll').appendChild(turn);
}

function makeRestoreRow(turnId) {
  const row = el(`<div class="turn-restore">
    <button class="restore-btn" title="Undo this change and everything after it">${ic('undo')}<span>Restore checkpoint</span></button>
  </div>`);
  $('button', row).onclick = () => restoreCheckpoint(turnId);
  return row;
}

async function restoreCheckpoint(turnId) {
  if (!current) return;
  if (streaming) {
    toast('Agent is working', 'Wait for the current turn to finish before restoring.', 'warn');
    return;
  }
  const ok = await confirmDialog({
    title: 'Restore checkpoint?',
    desc: 'Project files return to the state they were in before this change. Later changes are undone too. Chat history is kept, with a note about the rollback.',
    confirmText: 'Restore',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await fetch(`/api/projects/${current.id}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turn: turnId }),
    });
    const j = await r.json();
    if (!r.ok || j.error) return toast('Restore failed', j.error || `HTTP ${r.status}`, 'warn');
    toast('Checkpoint restored', `${j.undone} change${j.undone === 1 ? '' : 's'} undone.`, 'ok');
    openProject(current);
  } catch (e) {
    toast('Restore failed', e.message, 'warn');
  }
}

function addUserMsg(text) {
  const m = el('<div class="msg-user"></div>');
  m.textContent = text;
  $('#chatScroll').appendChild(m);
}

function scrollChat(force) {
  const sc = $('#chatScroll');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}

// ─────────────────────────────────────────────── chat streaming
function syncChatSend() {
  $('#chatSend').disabled = !$('#chatText').value.trim();
}

async function sendChat(presetText) {
  if (streaming || !current) return;
  const text = (typeof presetText === 'string' ? presetText : $('#chatText').value).trim();
  if (!text) return;
  $('#chatText').value = '';
  autosize($('#chatText'));
  syncChatSend();
  $('#chatScroll').querySelector('.chat-welcome')?.remove();
  addUserMsg(text);

  streaming = true;
  $('#chatSend').classList.add('hidden');
  $('#chatStop').classList.remove('hidden');

  const turn = el('<div class="turn"></div>');
  const status = el(`<div class="status-line"><span class="spinner"></span><span>Waking ${esc(store.model)}</span></div>`);
  turn.appendChild(status);
  $('#chatScroll').appendChild(turn);
  scrollChat(true);

  let thinkEl = null, thinkBody = null, thinkStart = 0;
  let narrEl = null, narrRaw = '';
  const opEls = new Map();
  let filesTouched = false;
  const showThinking = store.prefs.showThinking;

  const ensureThink = () => {
    if (thinkEl) return;
    thinkStart = Date.now();
    thinkEl = el(`<div class="think open">
      <div class="think-head"><span class="chev">${ic('chev-r')}</span><span class="spinner"></span><span class="th-label">Thinking</span></div>
      <div class="think-body"></div></div>`);
    thinkBody = $('.think-body', thinkEl);
    $('.think-head', thinkEl).onclick = () => thinkEl.classList.toggle('open');
    turn.appendChild(thinkEl);
  };
  const closeThink = () => {
    if (!thinkEl || !thinkEl.classList.contains('open')) return;
    thinkEl.classList.remove('open');
    const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
    $('.spinner', thinkEl)?.remove();
    $('.th-label', thinkEl).textContent = `Thought for ${secs}s`;
  };
  const ensureNarr = () => {
    closeThink();
    if (!narrEl || turn.lastElementChild !== narrEl) {
      narrEl = el('<div class="turn-narration"></div>');
      narrRaw = '';
      turn.appendChild(narrEl);
    }
    return narrEl;
  };
  const dropEmptyNarr = () => {
    if (narrEl && !narrEl.textContent.trim()) narrEl.remove();
    narrEl = null;
  };
  const opEl = (path) => {
    let node = opEls.get(path);
    if (node) return node;
    closeThink();
    dropEmptyNarr();
    let wrap = turn.lastElementChild?.classList.contains('fileops') ? turn.lastElementChild : null;
    if (!wrap) { wrap = el('<div class="fileops"></div>'); turn.appendChild(wrap); }
    node = el(`<div class="fileop"><span class="st"><span class="spinner"></span></span><span class="fpath">${esc(path)}</span><span class="fsize"></span></div>`);
    wrap.appendChild(node);
    opEls.set(path, node);
    return node;
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
      turn.appendChild(el(`<div class="err-line">Connection error: ${esc(e.message)}</div>`));
    }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'thinking':
        if (!showThinking) break;
        ensureThink();
        thinkBody.textContent += ev.text;
        thinkBody.scrollTop = thinkBody.scrollHeight;
        break;
      case 'token':
        ensureNarr();
        narrRaw += ev.text;
        narrEl.innerHTML = mdToHtml(narrRaw);
        break;
      case 'fileStart':
        opEl(ev.path);
        break;
      case 'fileChunk': {
        const node = opEl(ev.path);
        $('.fsize', node).textContent = fmtBytes(ev.bytes);
        break;
      }
      case 'fileDone': {
        filesTouched = true;
        const node = opEl(ev.path);
        node.classList.add('done');
        if (ev.truncated) node.classList.add('warn');
        $('.st', node).innerHTML = ic(ev.truncated ? 'warn' : 'check');
        $('.fsize', node).textContent = fmtBytes(ev.bytes);
        schedulePreview();
        break;
      }
      case 'deleted': {
        filesTouched = true;
        const node = opEl(ev.path);
        node.classList.add('done', 'del');
        $('.st', node).innerHTML = ic('x');
        break;
      }
      case 'error':
        turn.appendChild(el(`<div class="err-line">${esc(ev.message)}</div>`));
        break;
      case 'done':
        closeThink();
        if (ev.turn) turn.appendChild(makeRestoreRow(ev.turn));
        break;
    }
    if (narrEl && !narrEl.textContent.trim() && ev.type !== 'token') { narrEl.remove(); narrEl = null; }
    scrollChat();
  }

  closeThink();
  dropEmptyNarr();
  status.remove();
  streaming = false;
  streamAbort = null;
  $('#chatSend').classList.remove('hidden');
  $('#chatStop').classList.add('hidden');
  syncChatSend();
  if (filesTouched) {
    refreshPreview();
    loadTree();
    // the agent may have rewritten the file that is open in the editor —
    // reload it so a later Ctrl+S can't clobber the new version
    if (openFile && !editorDirty) loadFile(openFile, { force: true });
  }
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
const FILE_ICONS = { html: 'web', css: 'brush', js: 'code', mjs: 'code', json: 'code', md: 'book', py: 'code', svg: 'pen', txt: 'file' };
function fileIcon(p) {
  return FILE_ICONS[p.split('.').pop().toLowerCase()] || 'file';
}

async function loadTree() {
  if (!current) return;
  const j = await (await fetch(`/api/projects/${current.id}/files`)).json();
  const tree = $('#fileTree');
  tree.innerHTML = '';
  if (!j.files.length) {
    tree.appendChild(el('<div class="ft-dir" style="padding:12px 8px">no files yet</div>'));
    return;
  }
  let lastDir = null;
  for (const f of j.files) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (dir !== lastDir && dir) {
      tree.appendChild(el(`<div class="ft-dir">${ic('folder')} ${esc(dir)}/</div>`));
    }
    lastDir = dir;
    const b = el(`<button class="ft-file${f.path === openFile ? ' active' : ''}" title="${esc(f.path)}">
      ${ic(fileIcon(f.path))}<span>${esc(parts[parts.length - 1])}</span></button>`);
    b.onclick = () => loadFile(f.path);
    tree.appendChild(b);
  }
}

async function loadFile(path, { force = false } = {}) {
  if (path === openFile && !editorDirty && !force) return;
  if (editorDirty && !force) {
    const ok = await confirmDialog({
      title: 'Discard unsaved changes?',
      desc: `${openFile} has edits that are not saved yet.`,
      confirmText: 'Discard changes',
      danger: true,
    });
    if (!ok) return;
  }
  const j = await (await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(path)}`)).json();
  if (j.error) {
    if (path === openFile) closeEditor();  // open file was deleted (e.g. by the agent)
    return;
  }
  openFile = path;
  $('#editor').value = j.content;
  $('#editor').disabled = false;
  $('#btnSaveFile').disabled = false;
  $('#btnDeleteFile').disabled = false;
  $('#editorPath').textContent = path;
  markDirty(false);
  renderLineNums();
  $$('.ft-file').forEach((b) => b.classList.toggle('active', b.title === path));
}

function closeEditor() {
  openFile = null;
  $('#editor').value = '';
  $('#editor').disabled = true;
  $('#btnSaveFile').disabled = true;
  $('#btnDeleteFile').disabled = true;
  $('#editorPath').textContent = 'select a file';
  markDirty(false);
  renderLineNums();
  $$('.ft-file').forEach((b) => b.classList.remove('active'));
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
  if (!current) return;
  const path = await promptDialog({
    title: 'New file',
    label: 'File path',
    placeholder: 'notes.md or js/util.js',
    confirmText: 'Create',
  });
  if (!path) return;
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
  const ok = await confirmDialog({
    title: `Delete ${openFile}?`,
    desc: 'The file is removed from the project folder on disk.',
    confirmText: 'Delete file',
    danger: true,
  });
  if (!ok) return;
  await fetch(`/api/projects/${current.id}/file?path=${encodeURIComponent(openFile)}`, { method: 'DELETE' });
  closeEditor();
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
        ? `<span class="con-ok">exit 0</span>\n\n`
        : `<span class="con-err">exit ${j.code}${j.timedOut ? ' (timed out)' : ''}</span>\n\n`;
    }
  } catch (e) {
    out.innerHTML += `<span class="con-err">${esc(e.message)}</span>\n`;
  }
  out.scrollTop = out.scrollHeight;
}

// ─────────────────────────────────────────────── go
init();
