'use strict';

/**
 * Model-provider registry. Presents one surface to the rest of the app so the
 * agent loop, protocol parser, checkpoints, and RUN loop are all
 * provider-agnostic:
 *   listModels()  -> merged catalog across every available provider
 *   chatStream()  -> { provider, model, messages, signal } -> Replica events
 *   health()      -> per-provider availability
 *
 * Ollama stays the default (local, no auth). The CLI providers (Claude, and
 * optionally Gemini / Copilot) are "frictionless BYO-model": they reuse a
 * login the user already has and need no API key.
 */

const config = require('./config');
const ollama = require('./ollama');
const claudeCli = require('./providers/claudeCli');
const { gemini, copilot } = require('./providers/plainCli');

// Ollama wrapped as a provider (normalises its model shape to carry id/provider).
const ollamaProvider = {
  id: 'ollama',
  async detect() { return { available: await ollama.isUp() }; },
  async listModels() {
    return (await ollama.listModels()).map((m) => ({
      id: m.name,               // bare name — backward compatible with stored prefs
      provider: 'ollama',
      model: m.name,
      name: m.name,
      label: m.name,
      params: m.params || '',
      sub: 'Local',
    }));
  },
  chatStream: ollama.chatStream,
};

const REGISTRY = {
  ollama: ollamaProvider,
  claude: claudeCli,
  gemini,
  copilot,
};

function get(provider) {
  return REGISTRY[provider] || ollamaProvider;
}

/** Per-provider availability, cached briefly so /api/models and /api/health are cheap. */
let detectCache = null;
let detectAt = 0;
async function detectAll() {
  const now = Date.now();
  if (detectCache && now - detectAt < 5000) return detectCache;
  const entries = await Promise.all(
    Object.entries(REGISTRY).map(async ([id, p]) => {
      try { return [id, await p.detect()]; } catch { return [id, { available: false }]; }
    }),
  );
  detectCache = Object.fromEntries(entries);
  detectAt = now;
  return detectCache;
}

/** Merged model catalog from every available provider. Ollama first. */
async function listModels() {
  const status = await detectAll();
  const order = ['ollama', 'claude', 'gemini', 'copilot'];
  const out = [];
  for (const id of order) {
    if (!status[id] || !status[id].available) continue;
    try {
      const list = await REGISTRY[id].listModels();
      out.push(...list);
    } catch { /* a provider that errors while listing is simply skipped */ }
  }
  return out;
}

async function health() {
  const status = await detectAll();
  return {
    ollama: !!(status.ollama && status.ollama.available),
    claude: !!(status.claude && status.claude.available),
    gemini: !!(status.gemini && status.gemini.available),
    copilot: !!(status.copilot && status.copilot.available),
  };
}

/** True if at least one provider is usable. */
async function isUp() {
  const h = await health();
  return h.ollama || h.claude || h.gemini || h.copilot;
}

function chatStream({ provider, model, messages, signal }) {
  return get(provider || 'ollama').chatStream({ model, messages, signal });
}

module.exports = { listModels, health, isUp, chatStream, detectAll, REGISTRY };
