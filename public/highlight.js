/* Replica syntax highlighting: a small regex tokenizer, no dependencies.
   Exposes window.replicaHighlight(code, lang) -> HTML string with tk-* spans.
   Token classes: tk-com (comments), tk-str (strings), tk-num (numbers and
   colors), tk-kw (keywords and at-rules), tk-attr (properties, attributes,
   JSON keys), tk-tag (HTML tag names). Unknown languages come back escaped
   but unstyled, so this can never make text unreadable. */
'use strict';
(function () {
  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  /** Walk one combined regex over src; group N-1 maps to classes[N-1]. */
  function tokenize(src, re, classes) {
    let out = '';
    let last = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      let cls = '';
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) { cls = classes[g - 1]; break; }
      }
      out += cls ? `<span class="tk-${cls}">${esc(m[0])}</span>` : esc(m[0]);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out + esc(src.slice(last));
  }

  const JS_KW = 'abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield';
  const PY_KW = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|self|True|try|while|with|yield';

  const LANGS = {
    js: {
      re: new RegExp(
        '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)'
        + '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)'
        + '|\\b(0[xXbBoO][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b'
        + `|\\b(${JS_KW})\\b`, 'g'),
      classes: ['com', 'str', 'num', 'kw'],
    },
    css: {
      re: /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@[\w-]+)|(#[0-9a-fA-F]{3,8}\b)|([\w-]+(?=\s*:))|(-?\d+(?:\.\d+)?[a-z%]*)/g,
      classes: ['com', 'str', 'kw', 'num', 'attr', 'num'],
    },
    json: {
      re: /("(?:[^"\\]|\\.)*")(?=\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
      classes: ['attr', 'str', 'num', 'kw'],
    },
    py: {
      re: new RegExp(
        '(#[^\\n]*)'
        + '|("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')'
        + '|\\b(\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b'
        + '|(@[\\w.]+)'
        + `|\\b(${PY_KW})\\b`, 'g'),
      classes: ['com', 'str', 'num', 'kw', 'kw'],
    },
  };

  const ALIAS = {
    mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
    htm: 'html', svg: 'html', xml: 'html',
  };

  const ATTR_RE = /([\w-]+)(?==)|("[^"]*"|'[^']*')/g;

  function highlightHtml(src) {
    let out = '';
    let last = 0;
    const re = /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?>)/g;
    let m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1] !== undefined) {
        out += `<span class="tk-com">${esc(m[1])}</span>`;
      } else {
        out += esc(m[2])
          + `<span class="tk-tag">${esc(m[3])}</span>`
          + tokenize(m[4], ATTR_RE, ['attr', 'str'])
          + esc(m[5]);
      }
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  const MAX_HIGHLIGHT = 150_000;

  function replicaHighlight(code, lang) {
    const src = String(code ?? '');
    const l = ALIAS[lang] || lang;
    if (src.length > MAX_HIGHLIGHT) return esc(src);
    if (l === 'html') return highlightHtml(src);
    const def = LANGS[l];
    if (!def) return esc(src);
    return tokenize(src, def.re, def.classes);
  }

  window.replicaHighlight = replicaHighlight;
})();
