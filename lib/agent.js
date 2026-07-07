'use strict';

/**
 * The agent "brain": the output protocol the model is instructed to follow,
 * the per-turn system prompt (which embeds the live project file contents),
 * and the streaming parsers that turn raw model output into file operations.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { TEXT_EXT, listFiles } = require('./store');

const PROTOCOL_PROMPT = `You are Replica Agent, an autonomous senior software engineer inside Replica, a fully local Replit-style workspace. You build and modify real projects by writing complete files, which are saved to disk as you stream them.

STRICT OUTPUT PROTOCOL
- To create or overwrite a file, output exactly this block:
<<<FILE: relative/path.ext>>>
(the complete file contents)
<<<END FILE>>>
- To delete a file, output on its own line: <<<DELETE: relative/path.ext>>>
- NEVER wrap these blocks in markdown code fences. No \`\`\` anywhere.
- Always write the COMPLETE contents of every file. Never use placeholders, ellipses, or comments like "rest unchanged".
- Outside file blocks, speak to the user briefly: 1-3 sentences of plan before the first file, and 1-2 sentences of summary after the last one. No headings, no bullet lists of the code you already wrote.

ENGINEERING RULES
- Default stack is a static web app: index.html + style.css + script.js in vanilla JS. The project is previewed in an iframe served from the project root, and index.html is the entry point.
- Use relative asset paths ("style.css", not "/style.css").
- Zero external network dependencies: no CDNs, no Google Fonts, no external images. Use system font stacks, inline SVG, CSS gradients, and emoji.
- Make the result genuinely polished: real layout, spacing, hover/focus states, sensible color palette, empty states, and responsive behavior.
- Persist user data with localStorage where it makes sense.
- If the user asks for Python or Node scripts, write them; the user runs them in the Console tab with "python file.py" or "node file.js".
- When modifying an existing project, rewrite only the files that change, but each rewritten file must be complete.`;

/** Build the system prompt for one turn: protocol + live project context. */
async function buildSystemPrompt(dir, meta) {
  const files = await listFiles(dir);
  let ctx = '';
  let total = 0;
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      ctx += `\n--- ${f.path} (binary or unrecognized, ${f.size} bytes) ---\n`;
      continue;
    }
    let body = '';
    try { body = await fsp.readFile(path.join(dir, f.path), 'utf8'); } catch { continue; }
    if (body.length > config.contextFileCap) {
      body = body.slice(0, config.contextFileCap) + `\n…(truncated, ${body.length} chars total)`;
    }
    if (total + body.length > config.contextTotalCap) {
      ctx += `\n--- ${f.path} (omitted for length) ---\n`;
      continue;
    }
    total += body.length;
    ctx += `\n--- ${f.path} ---\n${body}\n`;
  }
  const fileSection = files.length
    ? `CURRENT PROJECT FILES (source of truth):\n${ctx}`
    : 'The project is currently EMPTY. Create it from scratch.';
  return `${PROTOCOL_PROMPT}\n\nPROJECT: ${meta.name}\n${meta.description ? 'BRIEF: ' + meta.description + '\n' : ''}\n${fileSection}`;
}

/**
 * Streaming parser for the agent protocol. Call feed() with content chunks
 * as they arrive; events fire as soon as markers complete. Partial markers
 * at chunk boundaries are held back until they can be resolved. Call
 * finish() at end-of-stream to flush (a file cut off mid-stream is emitted
 * with truncated=true so the caller can flag it).
 *
 * events: { narration(text), fileStart(path), fileChunk(path, bytes),
 *           fileDone(path, content, truncated), del(path) }
 */
function createAgentParser(ev) {
  const FILE_RE = /<<<FILE:\s*([^>\n]+?)\s*>>>[ \t]*\r?\n?/;
  const DEL_RE = /<<<DELETE:\s*([^>\n]+?)\s*>>>/;
  const END_MARK = '<<<END FILE>>>';
  let buf = '';
  let inFile = false;
  let filePath = '';
  let fileBuf = '';

  function stripFences(content) {
    return content.replace(/^```[a-z]*\r?\n/i, '').replace(/\r?\n```\s*$/, '');
  }

  function pump() {
    for (;;) {
      if (!inFile) {
        const m = buf.match(FILE_RE);
        const d = buf.match(DEL_RE);
        if (m && (!d || m.index <= d.index)) {
          if (m.index > 0) ev.narration(buf.slice(0, m.index));
          buf = buf.slice(m.index + m[0].length);
          filePath = m[1].trim();
          fileBuf = '';
          inFile = true;
          ev.fileStart(filePath);
          continue;
        }
        if (d) {
          if (d.index > 0) ev.narration(buf.slice(0, d.index));
          buf = buf.slice(d.index + d[0].length);
          ev.del(d[1].trim());
          continue;
        }
        // hold back a tail that could be the start of a marker
        const hold = 48;
        if (buf.length > hold) {
          ev.narration(buf.slice(0, buf.length - hold));
          buf = buf.slice(buf.length - hold);
        }
        return;
      }
      const end = buf.indexOf(END_MARK);
      if (end !== -1) {
        fileBuf += buf.slice(0, end);
        buf = buf.slice(end + END_MARK.length);
        const content = stripFences(fileBuf.replace(/\r?\n$/, ''));
        inFile = false;
        ev.fileDone(filePath, content, false);
        filePath = '';
        fileBuf = '';
        continue;
      }
      const hold = END_MARK.length + 8;
      if (buf.length > hold) {
        fileBuf += buf.slice(0, buf.length - hold);
        buf = buf.slice(buf.length - hold);
        ev.fileChunk(filePath, fileBuf.length);
      }
      return;
    }
  }

  return {
    feed(text) { buf += text; pump(); },
    finish() {
      if (inFile) {
        const content = stripFences(fileBuf + buf);
        ev.fileDone(filePath, content, true);
      } else if (buf.trim()) {
        ev.narration(buf);
      }
      buf = '';
      inFile = false;
    },
  };
}

/**
 * Filter that splits inline <think>…</think> spans out of a content stream.
 * Newer Ollama builds surface thinking on a dedicated channel, but some
 * models still inline the tags; this handles both without double-rendering.
 * Returns { feed(text), flush() }.
 */
function createThinkFilter({ onThinking, onContent }) {
  const OPEN = '<think>';
  const CLOSE = '</think>';
  let buf = '';
  let inThink = false;

  function feed(text) {
    buf += text;
    for (;;) {
      if (inThink) {
        const close = buf.indexOf(CLOSE);
        if (close === -1) {
          const hold = CLOSE.length + 1;
          if (buf.length > hold) {
            onThinking(buf.slice(0, buf.length - hold));
            buf = buf.slice(buf.length - hold);
          }
          return;
        }
        onThinking(buf.slice(0, close));
        buf = buf.slice(close + CLOSE.length);
        inThink = false;
      } else {
        const open = buf.indexOf(OPEN);
        if (open === -1) {
          const hold = OPEN.length + 1;
          if (buf.length > hold) {
            onContent(buf.slice(0, buf.length - hold));
            buf = buf.slice(buf.length - hold);
          }
          return;
        }
        if (open > 0) onContent(buf.slice(0, open));
        buf = buf.slice(open + OPEN.length);
        inThink = true;
      }
    }
  }

  function flush() {
    if (buf) {
      if (inThink) onThinking(buf);
      else onContent(buf);
    }
    buf = '';
  }

  return { feed, flush };
}

module.exports = { PROTOCOL_PROMPT, buildSystemPrompt, createAgentParser, createThinkFilter };
