'use strict';

/** Thin client for the local Ollama HTTP API. */

const config = require('./config');

/** Chat-capable models installed in Ollama (embedding models filtered out). */
async function listModels() {
  const r = await fetch(`${config.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Ollama /api/tags responded ${r.status}`);
  const j = await r.json();
  return (j.models || [])
    .filter((m) => {
      if (m.capabilities) return m.capabilities.includes('completion');
      return !/embed|bge|minilm/i.test(m.name);
    })
    .map((m) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family || '',
      params: m.details?.parameter_size || '',
    }));
}

async function isUp() {
  try {
    return (await fetch(`${config.ollamaHost}/api/version`, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

/**
 * Stream a chat completion. Async generator yielding parsed NDJSON objects
 * from Ollama ({message: {content, thinking?}, done, error?}).
 * Throws on transport / non-2xx errors.
 */
async function* chatStream({ model, messages, signal }) {
  const upstream = await fetch(`${config.ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: config.keepAlive,
      options: { temperature: config.temperature, num_ctx: config.numCtx },
    }),
  });
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    throw new Error(`Ollama ${upstream.status}: ${errText.slice(0, 400)}`);
  }
  let lineBuf = '';
  const decoder = new TextDecoder();
  for await (const chunk of upstream.body) {
    lineBuf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip malformed lines rather than killing the stream
      }
    }
  }
}

module.exports = { listModels, isUp, chatStream };
