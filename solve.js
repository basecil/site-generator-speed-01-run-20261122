// site-generator-speed-01-run-20261122: a faster drop-in for makefun-site 1.0.0.
// Own implementation of the vendor spec (vendor README.md + vendor code as the
// reference where they differ). Byte-exact by construction: every edge behavior
// of the reference is preserved (see tools/BUILD.md spec-traps list).
//
// Speed strategy (profiled 2026-11-23: markdown ~70% of build CPU, layouts
// ~23%): single-pass Markdown with no token objects and a run-based inline
// scanner (no per-character regex escape); scan-based escapeHtml; memoized
// slugify with an ASCII fast path; index-based front matter (no whole-body
// split/join); scan-based word count; a \r fast path in readSources. The
// template parser/renderer are ported verbatim (parse is ~1 ms/set); only the
// escape function they use is faster.
//
// No imports, no file/clock/env/random access. Per-run caches (slugCache) are
// created fresh inside run() and dropped when it returns: nothing is cached
// from one case to the next.

/* ------------------------------------------------------------------ text */

// The HTML escape table, in this order: & < > " '.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A test for the first escapable character, so strings holding none skip the scan loop entirely. */
const NEEDS_ESCAPE = /[&<>"']/;

/** `text` with & < > " and ' escaped. Single scan; returns the input itself when it holds no special char. */
export function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  let out = null;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (out === null) out = text.slice(0, i);
      else if (run < i) out += text.slice(run, i);
      out += ESCAPES[text[i]];
      run = i + 1;
    }
  }
  if (out === null) return text;
  if (run < text.length) out += text.slice(run);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Per-run slug memo: one Map, cleared at the start and end of every build() — never shared between cases. */
const slugCache = new Map();

/** The reference slug algorithm, for non-ASCII input (NFKD + combining marks). */
function slugifyFull(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when nothing
 * is left. Pure-ASCII input takes a fast path (NFKD is the identity on ASCII,
 * and ASCII holds no combining marks); anything else falls back to slugifyFull.
 * Memoized per run: titles and tags repeat within a case.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) {
      ascii = false;
      break;
    }
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (!ascii) {
    out = slugifyFull(text);
  } else {
    let end = out.length < SLUG_MAX ? out.length : SLUG_MAX;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = out.slice(0, end);
    if (out === '') out = 'untitled';
  }
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  return `${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/* ------------------------------------------------------------ front matter */

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. Index-based: only the front-matter lines are materialized; the body is sliced, never split and re-joined.
 */
export function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closed = false;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') {
      closed = true;
      pos = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(pos) };
}

/* --------------------------------------------------------------- markdown */

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A line of spaces/tabs only (the empty line included). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && FENCE_OPEN.test(line)) return true;
  if (c0 === 35 && headingOf(line) !== null) return true;
  if ((c0 === 45 || c0 === 42) && HR.test(line)) return true;
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the `what` at `j` is escaped: an odd run of backslashes immediately before it (each pair escapes the next backslash, the last escapes the first char of `what`, which must be escapable for the escape to count — `*` and `]` are). */
function isEscapedAt(s, j) {
  let k = 0;
  while (j - 1 - k >= 0 && s[j - 1 - k] === '\\') k++;
  return k % 2 === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, before `hi`, or -1. */
function findUnescaped(s, what, from, hi) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= hi && isEscapedAt(s, j)) j = s.indexOf(what, j + 1);
  return j !== -1 && j + what.length <= hi ? j : -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, before `hi`, or -1. The escape check comes first: an escaped star is never considered for pairing, as in the reference's scan. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (isEscapedAt(s, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < hi && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct or need escaping: \ ` * [ & < > " '. One shared regex; every path sets lastIndex before the next exec, so synchronous recursion cannot clobber it. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s[lo..hi)` rendered inline; `env.link(target)` is a link's href. Bounds-based (no slices for nested constructs):
 * the scanner jumps from one special character to the next with a regex exec, and literal runs are copied verbatim,
 * so no character is ever passed through a regex escape. Unmatched openers stay in the run, exactly as the reference
 * writes them literally. When `parts` is given, the pieces are pushed into it and nothing is returned (one join at
 * the top level, no nested re-copying); otherwise a local array is joined and returned. (Measured 2026-11-23: 2.3x
 * faster than the per-character loop on the practice bodies, byte-identical on all 1,024 bodies plus 30 edge strings.)
 */
export function inline(s, lo, hi, env, parts) {
  const own = parts === undefined;
  if (own) parts = [];
  let run = lo;
  INLINE_SPECIAL.lastIndex = lo;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null && m.index < hi) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // Backslash: an escapable next char is written (escaped); anything else
      // leaves the backslash itself in the run.
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        if (run < i) parts.push(s.slice(run, i));
        parts.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        INLINE_SPECIAL.lastIndex = i + 2;
        run = i + 2;
      } else INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        if (run < i) parts.push(s.slice(run, i));
        parts.push(`<code>${escapeHtml(s.slice(i + 1, j))}</code>`);
        INLINE_SPECIAL.lastIndex = j + 1;
        run = j + 1;
      } else INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 42) {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          if (run < i) parts.push(s.slice(run, i));
          parts.push('<strong>');
          inline(s, i + 2, j, env, parts);
          parts.push('</strong>');
          INLINE_SPECIAL.lastIndex = j + 2;
          run = j + 2;
        } else INLINE_SPECIAL.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        if (run < i) parts.push(s.slice(run, i));
        parts.push('<em>');
        inline(s, i + 1, j, env, parts);
        parts.push('</em>');
        INLINE_SPECIAL.lastIndex = j + 1;
        run = j + 1;
      } else INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      const mm = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm !== -1 && mm < hi ? s.slice(k + 2, mm) : '';
      if (target !== '' && !/\s/.test(target)) {
        if (run < i) parts.push(s.slice(run, i));
        parts.push(`<a href="${escapeHtml(env.link(target))}">`);
        inline(s, i + 1, k, env, parts);
        parts.push('</a>');
        INLINE_SPECIAL.lastIndex = mm + 1;
        run = mm + 1;
      } else INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (run < i) parts.push(s.slice(run, i));
    parts.push(ESCAPES[s[i]]);
    INLINE_SPECIAL.lastIndex = i + 1;
    run = i + 1;
  }
  if (run < hi) parts.push(s.slice(run, hi));
  return own ? parts.join('') : undefined;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Single pass over the lines: blocks render straight to the output, no token objects. Block dispatch runs the
 * reference's regexes only when a cheap first-char check says they can match.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const parts = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        const codeLines = [];
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // the close line is consumed even when the body ran to EOF
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        parts.push(`<pre><code${cls}>${codeLines.length === 0 ? '' : `${escapeHtml(codeLines.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, 0, h.text.length, env);
        parts.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        i++;
        const t = trimLine(l);
        if (t !== '') body.push(t);
      }
      if (body.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = body.join('\n');
        parts.push('<blockquote>\n<p>');
        inline(joined, 0, joined.length, env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    if (bullet === null && c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const lis = [];
      for (const item of items) {
        const joined = item.join('\n');
        lis.push('<li>');
        inline(joined, 0, joined.length, env, lis);
        lis.push('</li>\n');
      }
      parts.push(`${open}\n${lis.join('')}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const joined = body.join('\n');
    if (excerpt === null) {
      const html = inline(joined, 0, joined.length, env);
      excerpt = html;
      parts.push(`<p>${html}</p>\n`);
    } else {
      parts.push('<p>');
      inline(joined, 0, joined.length, env, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * A parsed template compiled to flat instructions. Instruction arrays, first element the op:
 * 0 text: [0, text]
 * 1 var (escaped): [1, frame, name, segs] — frame -1 = root vars, else the for-frame depth from the innermost (0 = innermost)
 * 2 raw: [2, frame, name, segs]
 * 3 if: [3, frame, name, segs, not, then, else|null]
 * 4 for: [4, frame, name, segs, loopVar, body]
 * 5 include (direct): [5, instrs]
 * 6 include (deferred, for include cycles): [6, key]
 *
 * A path's first name is resolved at compile time against the binding stack: the for-frames enclosing the node (each
 * binds its loop variable and `loop`), innermost first, else the root vars. An include compiles its target in the
 * includer's binding context at that point — an included template sees the includer's for-frames, exactly as the
 * reference's scope chain does (card is included from inside {% for p in posts %} and reads p.*; tag-list, included
 * from card, reads p.tags from two levels up). Programs are memoized per (template, binding context); an include
 * cycle falls back to a deferred instruction resolved from the memo at render time.
 */
function resolveFrame(name, stack) {
  for (let d = stack.length - 1; d >= 0; d--) {
    if (stack[d] === name || name === 'loop') return stack.length - 1 - d;
  }
  return -1;
}

function compileNodes(nodes, stack, parsed, memo, inProgress) {
  const out = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push([0, n.text]);
        break;
      case 'var':
      case 'raw': {
        const p = n.path;
        out.push([n.kind === 'var' ? 1 : 2, resolveFrame(p[0], stack), p[0], p.slice(1)]);
        break;
      }
      case 'if': {
        const p = n.path;
        out.push([3, resolveFrame(p[0], stack), p[0], p.slice(1), n.not, compileNodes(n.then, stack, parsed, memo, inProgress), n.else === null ? null : compileNodes(n.else, stack, parsed, memo, inProgress)]);
        break;
      }
      case 'for': {
        const p = n.path;
        const instr = [4, resolveFrame(p[0], stack), p[0], p.slice(1), n.name, null];
        stack.push(n.name);
        instr[5] = compileNodes(n.body, stack, parsed, memo, inProgress);
        stack.pop();
        out.push(instr);
        break;
      }
      case 'include': {
        const target = parsed.get(n.name);
        if (target === undefined) break; // a missing include renders nothing
        const key = `${n.name}\n${stack.join(',')}`;
        if (inProgress.has(key)) {
          out.push([6, key]); // include cycle: resolve at render time
          break;
        }
        out.push([5, compileTemplate(n.name, stack, parsed, memo, inProgress)]);
        break;
      }
    }
  }
  return out;
}

/** `name` compiled in binding context `stack` (for-variable names, innermost last), memoized. */
function compileTemplate(name, stack, parsed, memo, inProgress) {
  const key = `${name}\n${stack.join(',')}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  inProgress.add(key);
  const prog = compileNodes(parsed.get(name), stack.slice(), parsed, memo, inProgress);
  inProgress.delete(key);
  memo.set(key, prog);
  return prog;
}

/** The value a compiled path instruction reads: its first name from the frame it names (or the root vars), then own properties only. */
function progValue(ins, frames, rootVars) {
  const f = ins[1];
  let v;
  if (f === -1) {
    if (!Object.hasOwn(rootVars, ins[2])) return undefined;
    v = rootVars[ins[2]];
  } else {
    v = frames[frames.length - 1 - f][ins[2]];
  }
  const segs = ins[3];
  for (let k = 0; k < segs.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segs[k])) return undefined;
    v = v[segs[k]];
  }
  return v;
}

/** An array's items as text, joined by ", " (the reference's textOf for arrays, without the intermediate array). */
function arrayText(v) {
  let out = '';
  for (let k = 0; k < v.length; k++) {
    if (k > 0) out += ', ';
    out += valueText(v[k]);
  }
  return out;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return arrayText(v);
  return '';
}

/**
 * Compiled `instrs` rendered into `parts` (one join at the top level, no nested re-copying): `frames` is the stack
 * of for-frames (each a vars object holding its loop variable and `loop`), `rootVars` the top-level vars ({site,
 * tags, recent, ...render vars}), `memo` the compiled-program map for deferred includes, `depth` the include depth.
 * A for-loop reuses one vars object across its elements (rendering is synchronous, nothing retains it); a loop
 * variable named `loop` never overwrites the loop object, as in the reference.
 */
export function renderProg(instrs, frames, rootVars, memo, depth, parts) {
  for (let k = 0; k < instrs.length; k++) {
    const ins = instrs[k];
    const op = ins[0];
    if (op === 0) {
      parts.push(ins[1]);
      continue;
    }
    if (op === 1) {
      const v = progValue(ins, frames, rootVars);
      if (typeof v === 'string') parts.push(escapeHtml(v));
      else if (typeof v === 'number') parts.push(String(v));
      else if (typeof v === 'boolean') parts.push(v ? 'true' : 'false');
      else if (Array.isArray(v)) parts.push(escapeHtml(arrayText(v)));
      continue;
    }
    if (op === 2) {
      parts.push(valueText(progValue(ins, frames, rootVars)));
      continue;
    }
    if (op === 3) {
      const v = progValue(ins, frames, rootVars);
      const t = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
      const branch = t !== ins[4] ? ins[5] : ins[6];
      if (branch !== null) renderProg(branch, frames, rootVars, memo, depth, parts);
      continue;
    }
    if (op === 4) {
      const xs = progValue(ins, frames, rootVars);
      if (!Array.isArray(xs)) continue;
      const loopVar = ins[4];
      const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
      const vars = { loop };
      frames.push(vars);
      for (let e = 0; e < xs.length; e++) {
        if (loopVar !== 'loop') vars[loopVar] = xs[e];
        loop.index = e + 1;
        loop.first = e === 0;
        loop.last = e === xs.length - 1;
        renderProg(ins[5], frames, rootVars, memo, depth, parts);
      }
      frames.pop();
      continue;
    }
    if (op === 5) {
      if (depth < INCLUDE_DEPTH) renderProg(ins[1], frames, rootVars, memo, depth + 1, parts);
      continue;
    }
    const prog = memo.get(ins[1]);
    if (prog !== undefined && depth < INCLUDE_DEPTH) renderProg(prog, frames, rootVars, memo, depth + 1, parts);
  }
}

/* ------------------------------------------------------------------- build */

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace (same count as /\S+/g, no array built). The space test is inlined (a call per character showed up in the profile) with an ASCII fast path. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII whitespace is all <= 32 (space, \t..\r); a control character below
    // 32 that is not \t..\r is not whitespace, and non-ASCII whitespace is the
    // Unicode spaces. The <= 32 filter halves the comparisons for letters.
    const sp = c <= 32 ? (c === 32 || (c >= 9 && c <= 13)) : (c > 127 && (c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff));
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.programs.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const resolved = new Map();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.startsWith('/') || target.startsWith('#')) return target;
        // A scheme needs a ':'; only then run the scheme regex.
        if (target.indexOf(':') !== -1 && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') path = null;
        else {
          const key = dir + '\n' + rel;
          path = resolved.get(key);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            resolved.set(key, path);
          }
        }
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. Tag views are memoized per tag object: the same tag appears in many cards. */
function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => {
      let view = b.tagViews.get(t);
      if (view === undefined) {
        view = { name: t.name, slug: t.slug, url: t.url };
        b.tagViews.set(t, view);
      }
      return view;
    }),
  };
}

/** A page as its layout reads it. Posts reuse their memoized card (same values, same key order); pages build one. The toc array is passed through as-is: templates only read it, nothing mutates it. */
function pageOf(b, s) {
  const card = s.post ? b.cards.get(s) : cardOf(b, s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const frames = [];
  const render = (name, vars) => {
    const prog = b.programs.get(name);
    if (prog === undefined) return null;
    // One root-vars object per case, its render keys reset each render (an
    // absent key reads as undefined, exactly as a missing key does).
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const parts = [];
    renderProg(prog, frames, rootVars, b.compiled, 0, parts);
    return parts.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. The slug memo is fresh per call. */
export function build(input) {
  slugCache.clear();
  try {
    return buildInner(input);
  } finally {
    slugCache.clear();
  }
}

function buildInner(input) {
  const parsed = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  // Every parsed template compiled once in the empty binding context; includes
  // compile their targets in the includer's context on demand (memoized).
  const compiled = new Map();
  const inProgress = new Set();
  const programs = new Map();
  for (const name of parsed.keys()) programs.set(name, compileTemplate(name, [], parsed, compiled, inProgress));
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    programs,
    compiled,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    tagViews: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
