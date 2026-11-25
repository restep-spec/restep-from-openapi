// Minimal YAML parser, enough for common OpenAPI documents. No dependencies.
//
// Supports: block maps and lists (including a list at the same indentation as its key), plain
// scalars (also over several lines), single- and double-quoted scalars, `|` literal and `>` folded
// blocks with their indicators (`|-`, `>+`, `|2`), inline collections (`[a, b]`, `{a: 1}`, also
// spread over several lines), comments, anchors `&a` and aliases `*a`, the merge key `<<`, and the
// markers `---`, `...` and `%YAML`.
// Does not support: several documents in one file (reads the first), complex keys `? `, tags
// `!!type` (ignored), or tabs in indentation.

export function parseYaml(text) {
  const lines = [];
  const raw = text.replace(/^﻿/, '').split(/\r?\n/);
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/^%/.test(line) && !started) continue;
    if (/^---(\s|$)/.test(line)) {
      if (started) break; // first document only
      started = true;
      const rest = line.slice(3).trim();
      if (rest && !rest.startsWith('#')) lines.push({ n: i + 1, indent: 0, text: rest, raw: rest });
      continue;
    }
    if (/^\.\.\.(\s|$)/.test(line)) break;
    const m = /^( *)(.*)$/.exec(line);
    if (/^ *\t/.test(line) && m[2].trim() && !m[2].trim().startsWith('#'))
      throw yamlError(i + 1, 'tab in indentation; YAML only allows spaces');
    started = true;
    lines.push({ n: i + 1, indent: m[1].length, text: m[2], raw: line });
  }
  const p = new Parser(lines);
  p.skipBlank();
  if (p.i >= lines.length) return null;
  const value = p.parseNode(lines[p.i].indent, -1);
  p.skipBlank();
  if (p.i < lines.length) throw yamlError(lines[p.i].n, `unexpected "${lines[p.i].text.trim()}" here (wrong indentation?)`);
  return value;
}

function yamlError(n, msg) {
  const e = new Error(`YAML, line ${n}: ${msg}`);
  e.yaml = true;
  return e;
}

// Strips a " #…" comment that is not inside quotes.
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        q = null;
      }
    } else if (c === '"' || c === "'") {
      // A quote only opens a string at the start of a value.
      const prev = s.slice(0, i).trimEnd();
      if (i === 0 || /[:\-,[{?]$/.test(prev) || prev === '') q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

// Finds the ":" that separates key and value: followed by a space or end of line, outside quotes and brackets.
function findColon(s) {
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    let i = 1;
    for (; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') { i++; continue; }
      if (s[i] === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } break; }
    }
    const rest = s.slice(i + 1);
    const m = /^\s*:(\s|$)/.exec(rest);
    return m ? i + 1 + rest.indexOf(':') : -1;
  }
  if (/^[[{]/.test(s)) return -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ':' && (i + 1 === s.length || s[i + 1] === ' ')) return i;
    if (s[i] === ' ' && s[i + 1] === '#') return -1;
  }
  return -1;
}

const isSeqLine = (t) => t === '-' || t.startsWith('- ');

class Parser {
  constructor(lines) { this.lines = lines; this.i = 0; this.anchors = new Map(); }

  skipBlank() {
    while (this.i < this.lines.length) {
      const t = this.lines[this.i].text.trim();
      if (t === '' || t.startsWith('#')) this.i++;
      else break;
    }
  }

  peek() { this.skipBlank(); return this.lines[this.i]; }

  // A node that starts on the current line with indentation `indent`; `parent` is the parent's indentation.
  parseNode(indent, parent) {
    const line = this.peek();
    if (!line || line.indent <= parent) return null;
    const t = stripComment(line.text);
    if (isSeqLine(t)) return this.parseSeq(line.indent);
    if (findColon(t) >= 0) return this.parseMap(line.indent);
    // A scalar or an inline collection that fills the whole block.
    this.i++;
    return this.inlineValue(t, line, parent);
  }

  parseSeq(indent) {
    const out = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      const t = stripComment(line.text);
      if (!isSeqLine(t)) break;
      const rest = t.slice(1).replace(/^ +/, '');
      if (rest === '') {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseNode(next.indent, indent) : null);
        continue;
      }
      // "- key: value" or "- - x": what follows the dash is reinterpreted as a more indented line.
      const offset = line.text.indexOf(rest);
      const { anchor, body } = splitAnchor(rest);
      if (isSeqLine(body) || findColon(body) >= 0) {
        this.lines[this.i] = { ...line, indent: line.indent + line.text.indexOf(body), text: body };
        const v = this.parseNode(line.indent + line.text.indexOf(body), indent);
        if (anchor) this.anchors.set(anchor, v);
        out.push(v);
        continue;
      }
      this.i++;
      const v = this.scalarWithContinuation(rest, line, indent, line.indent + offset);
      out.push(v);
    }
    return out;
  }

  parseMap(indent) {
    const out = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      const t = stripComment(line.text);
      if (isSeqLine(t)) break;
      if (t.startsWith('? ')) throw yamlError(line.n, 'complex keys ("? ") are not supported');
      const c = findColon(t);
      if (c < 0) throw yamlError(line.n, `expected "key: value", got "${t}"`);
      const key = String(scalar(t.slice(0, c).trim(), line.n, true));
      const rest = t.slice(c + 1).trim();
      this.i++;
      let value;
      const { anchor, body } = splitAnchor(rest);
      if (body === '') {
        const next = this.peek();
        if (next && (next.indent > indent || (next.indent === indent && isSeqLine(stripComment(next.text)))))
          value = this.parseNode(next.indent, next.indent === indent ? indent - 1 : indent);
        else value = null;
      } else value = this.inlineValue(body, line, indent);
      if (anchor) this.anchors.set(anchor, value);
      if (key === '<<') {
        for (const src of Array.isArray(value) ? value : [value])
          if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  // The value after "key:" or as a bare node.
  inlineValue(body, line, indent) {
    if (/^\*/.test(body)) {
      const name = body.slice(1).trim();
      if (!this.anchors.has(name)) throw yamlError(line.n, `alias "*${name}" has no anchor`);
      return this.anchors.get(name);
    }
    if (/^[|>]/.test(body)) return this.blockScalar(body, line, indent);
    if (/^[[{]/.test(body)) {
      // Inline collection, possibly spread over several lines.
      let text = body;
      while (!balanced(text)) {
        const next = this.lines[this.i];
        if (!next) throw yamlError(line.n, 'unclosed "[" or "{"');
        text += ' ' + stripComment(next.text.trim());
        this.i++;
      }
      return new Flow(text, line.n).parse();
    }
    const col = line.raw.indexOf(body);
    return this.scalarWithContinuation(body, line, indent, col);
  }

  // A plain scalar may continue on the following lines, indented deeper than its key.
  scalarWithContinuation(body, line, indent) {
    if (body.startsWith('"') || body.startsWith("'")) {
      let text = body;
      while (!closedQuote(text)) {
        const next = this.lines[this.i];
        if (!next) throw yamlError(line.n, 'unclosed quote');
        text += next.text.trim() === '' ? '\n' : ' ' + next.text.trim();
        this.i++;
      }
      return scalar(text.replace(/ \n /g, '\n'), line.n);
    }
    const parts = [body];
    for (;;) {
      const next = this.lines[this.i];
      if (!next) break;
      const t = next.text.trim();
      if (t === '' ) {
        // A blank line inside a scalar is a line break, if the scalar continues.
        let j = this.i + 1;
        while (j < this.lines.length && this.lines[j].text.trim() === '') j++;
        const after = this.lines[j];
        if (after && after.indent > indent && !after.text.trim().startsWith('#') && findColon(stripComment(after.text)) < 0) {
          parts.push('\n'); this.i = j; continue;
        }
        break;
      }
      if (next.indent <= indent || t.startsWith('#')) break;
      if (findColon(stripComment(t)) >= 0 || isSeqLine(t)) break;
      parts.push(stripComment(t));
      this.i++;
    }
    const joined = parts.reduce((acc, p) => (p === '\n' ? acc + '\n' : acc === '' || acc.endsWith('\n') ? acc + p : acc + ' ' + p), '');
    return scalar(joined, line.n);
  }

  blockScalar(header, line, indent) {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) throw yamlError(line.n, `invalid block header "${header}"`);
    const literal = m[1] === '|';
    const chomp = m[2] || m[4];
    let blockIndent = m[3] ? indent + Number(m[3]) : null;
    const body = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const rawText = l.raw;
      if (rawText.trim() === '') { body.push(''); this.i++; continue; }
      if (blockIndent === null) {
        if (l.indent <= indent) break;
        blockIndent = l.indent;
      }
      if (l.indent < blockIndent) break;
      body.push(rawText.slice(blockIndent));
      this.i++;
    }
    // Trailing blank lines do not belong to the block unless "+" is used.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    let text;
    if (literal) text = body.join('\n');
    else {
      text = '';
      for (let k = 0; k < body.length; k++) {
        const cur = body[k];
        if (k === 0) { text = cur; continue; }
        const prev = body[k - 1];
        if (cur === '') text += '\n';
        else if (prev === '' || /^\s/.test(cur) || /^\s/.test(prev)) text += (prev === '' ? '' : '\n') + cur;
        else text += ' ' + cur;
      }
    }
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return body.length ? text + '\n' : '';
  }
}

function splitAnchor(s) {
  const m = /^&([^\s]+)\s*(.*)$/.exec(s);
  let anchor = null, body = s;
  if (m) { anchor = m[1]; body = m[2]; }
  // Tags (!!str, !Ref…) are ignored.
  body = body.replace(/^!\S*\s*/, '');
  return { anchor, body };
}

function closedQuote(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } return true; }
  }
  return false;
}

function balanced(s) {
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

// Converts a scalar to its value, with the types of the YAML 1.2 core schema.
function scalar(s, n, isKey = false) {
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw yamlError(n, 'unclosed double quote');
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
      if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' }[e] ?? e;
    });
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw yamlError(n, 'unclosed single quote');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (isKey) return s;
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

// Inline collections: [a, b] and {a: 1, b: [2]}.
class Flow {
  constructor(s, n) { this.s = s; this.i = 0; this.n = n; }
  ws() { while (/\s/.test(this.s[this.i] ?? '')) this.i++; }
  parse() {
    const v = this.value();
    this.ws();
    if (this.i < this.s.length) throw yamlError(this.n, `unexpected "${this.s.slice(this.i)}" after flow collection`);
    return v;
  }
  value() {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') {
      this.i++;
      const out = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === ']') { this.i++; return out; }
        out.push(this.value());
        this.ws();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') throw yamlError(this.n, 'expected "," or "]"');
      }
    }
    if (c === '{') {
      this.i++;
      const out = {};
      for (;;) {
        this.ws();
        if (this.s[this.i] === '}') { this.i++; return out; }
        const key = String(this.atom(true));
        this.ws();
        let v = null;
        if (this.s[this.i] === ':') { this.i++; v = this.value(); }
        out[key] = v;
        this.ws();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') throw yamlError(this.n, 'expected "," or "}"');
      }
    }
    return this.atom(false);
  }
  atom(isKey) {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      let j = this.i + 1;
      for (; j < this.s.length; j++) {
        if (c === '"' && this.s[j] === '\\') { j++; continue; }
        if (this.s[j] === c) { if (c === "'" && this.s[j + 1] === "'") { j++; continue; } break; }
      }
      const tok = this.s.slice(this.i, j + 1);
      this.i = j + 1;
      return scalar(tok, this.n);
    }
    let j = this.i;
    while (j < this.s.length && !/[,\]}]/.test(this.s[j]) && !(this.s[j] === ':' && (/\s|[,\]}]/.test(this.s[j + 1] ?? ' ')))) j++;
    const tok = this.s.slice(this.i, j).trim();
    this.i = j;
    return scalar(tok, this.n, isKey);
  }
}
