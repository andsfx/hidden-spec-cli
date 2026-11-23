// main.ts is mend: the CLI SPEC.md specifies (MIT). It reads the four edit formats (a unified diff in section 6,
// SEARCH/REPLACE blocks in 7, V4A patches in 8 and JSON tool calls in 9), matches lines at the three tiers of
// section 5, and applies every edit or nothing (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fault of the patch text: exit 2 with this one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** A fault of one edit against the tree: exit 1 with `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** Strict matching (tier 0 only), from `--strict` (section 1). */
let STRICT = false;

const blank = (s: string): boolean => s.trim() === '';

/** The patch's lines (section 3): split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A file's text as the spec sees it: its lines, its line break, and whether it ends with one (section 3). */
interface Doc {
  lines: string[];
  eol: string;
  final: boolean;
}

function splitDoc(text: string): Doc {
  if (text === '') return { lines: [], eol: '\n', final: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(eol);
  const body = final ? text.slice(0, -eol.length) : text;
  return { lines: body.split(eol), eol, final };
}

function joinDoc(lines: string[], eol: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (final ? eol : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0];

/** The three tiers of section 5. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return trimWs(a) === trimWs(b);
}

/** Positions of O in lines at this tier, overlaps included. */
function occurrencesAt(hay: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (!tierEq(hay[i + j]!, needle[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once, and its occurrences. */
function matchTier(hay: string[], needle: string[], strict: boolean): { tier: number; where: number[] } {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const where = occurrencesAt(hay, needle, tier);
    if (where.length > 0) return { tier, where };
  }
  return { tier: -1, where: [] };
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and no segment is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One path of an edit, checked for safety before anything else (section 10). */
function safePath(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** One edit of a patch: O replaces k lines with N. */
interface Block {
  /** O: the lines the edit replaces; empty means an insertion. */
  oldLines: string[];
  /** N: the lines written in their place. */
  newLines: string[];
  /** For each line of N, the index of the O line it is the context of, or -1 (section 5). */
  ctx: number[];
  /** No final line break: a `\` line follows the hunk's last context or `+` line (section 6). */
  noFinalBreak: boolean;
}

/**
 * Replace the k file lines at `at` with N (section 5). A context line is written as the file's own matched line; at
 * tier 2 every other line of N is re-indented from O's first line to the file's.
 */
function replaceAt(hay: string[], at: number, k: number, b: Block, tier: number): string[] {
  const matched = hay.slice(at, at + k);
  const f = leadWs(matched[0] ?? '');
  const p = leadWs(b.oldLines[0] ?? '');
  const out = b.newLines.map((line, i) => {
    const c = b.ctx[i]!;
    if (c >= 0) return matched[c] ?? line;
    if (tier !== 2) return line;
    if (trimWs(line) === '') return line;
    if (p !== '') return line.startsWith(p) ? f + line.slice(p.length) : line;
    return f + line;
  });
  return [...hay.slice(0, at), ...out, ...hay.slice(at + k)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, for the `R` line (section 2). */
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** C22: true when the target path is occupied by a file, a directory or a virtual directory from an earlier edit. */
  exists(p: string): boolean {
    if (this.get(p) !== null) return true;
    try {
      if (!lstatSync(p).isFile()) return true;
    } catch {
      // No entry on disk: fall through to the virtual tree.
    }
    const prefix = `${p}/`;
    for (const [k, v] of this.now) {
      if (v !== null && k.startsWith(prefix)) return true;
    }
    return false;
  }
}

type Edit = (tree: Tree) => void;

/** A file an edit creates: LF breaks, ended by a line break unless the format says otherwise (section 3). */
function newFile(lines: string[], final = true): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (final ? '\n' : '');
}

// ── section 6: unified diffs ───────────────────────────────────────────────

/** One hunk: A, and its body lines (` `, `-`, `+`, `\` or an empty context line). */
interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hasPair: boolean;
  hunks: Hunk[];
  line: number;
}

/** `@@ -A[,B] +C[,D] @@`, optionally followed by text: A, or null when the line is not one (section 6). */
function hunkHeader(l: string): number | null {
  const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return m === null ? null : parseInt(m[1]!, 10);
}

/** `--- <path>`: the text after the four characters, up to the first tab, surrounding spaces removed (section 6). */
function headerPath(l: string): string {
  let s = l.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** A body line after its marker: an empty line is a context line whose text is empty (section 6). */
function bodyLine(l: string): { mark: string; text: string } {
  if (l === '') return { mark: ' ', text: '' };
  return { mark: l[0]!, text: l.slice(1) };
}

/** O, N and the context mapping of a hunk's body (section 5); a `\` line ends no-final-break. */
function hunkBlock(body: string[]): Block {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const ctx: number[] = [];
  for (const raw of body) {
    const { mark, text } = bodyLine(raw);
    if (mark === '\\') continue;
    if (mark === ' ') {
      ctx.push(oldLines.length);
      oldLines.push(text);
      newLines.push(text);
    } else if (mark === '-') {
      oldLines.push(text);
    } else if (mark === '+') {
      ctx.push(-1);
      newLines.push(text);
    }
  }
  let noFinalBreak = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const mark = bodyLine(body[k]!).mark;
    if (mark === ' ' || mark === '+') {
      noFinalBreak = k + 1 < body.length && bodyLine(body[k + 1]!).mark === '\\';
      break;
    }
  }
  return { oldLines, newLines, ctx, noFinalBreak };
}

/** The occurrence nearest `target`, the earlier of two equally near (section 6). */
function nearest(where: number[], target: number): number {
  let best = where[0]!;
  let bestD = Math.abs(best - target);
  for (const w of where) {
    const d = Math.abs(w - target);
    if (d < bestD) {
      best = w;
      bestD = d;
    }
  }
  return best;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  /** True once the section being read has had its first hunk. */
  let hunked = false;
  const pushSection = (oldPath: string | null, newPath: string | null, line: number): void => {
    cur = { oldPath, newPath, create: false, remove: false, hasPair: false, hunks: [], line };
    sections.push(cur);
    hunked = false;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const plusNext = (lines[i + 1] ?? '').startsWith('+++ ');
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git (\S+) (\S+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const oldP = m[1]!.replace(/^[ab]\//, '');
      const newP = m[2]!.replace(/^[ab]\//, '');
      pushSection(oldP, newP, i + 1);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && plusNext) {
      if (cur !== null && !hunked && !cur.hasPair) {
        // The `---`/`+++` pair of the section its header is being read for.
        const s = cur as Section;
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        s.oldPath = oldP === '/dev/null' ? null : oldP;
        s.newPath = newP === '/dev/null' ? null : newP;
        s.hasPair = true;
        i += 2;
        continue;
      }
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      pushSection(oldP === '/dev/null' ? null : oldP, newP === '/dev/null' ? null : newP, i + 1);
      (cur as Section).hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a, body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('@@')) break;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it (section 6).
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      (cur as Section).hunks.push(hunk);
      hunked = true;
      continue;
    }
    if (cur !== null && !hunked) {
      const s = cur as Section;
      if (l.startsWith('--- ')) {
        // A `---` with no `+++` after it, inside a section's header (section 6).
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) s.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) s.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) s.create = true;
      else if (l.startsWith('deleted file mode')) s.remove = true;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const isCreate = s.create || s.oldPath === null;
    const isRemove = s.remove || s.newPath === null;
    if (isCreate) {
      const path = s.newPath;
      if (path === null) throw new Exit2(`error: parse ${s.line}`);
      const text = createdText(s);
      edits.push((tree) => {
        safePath(path);
        if (tree.exists(path)) throw new Fail('exists', path);
        tree.now.set(path, text);
      });
      continue;
    }
    if (isRemove) {
      const path = s.oldPath ?? s.newPath;
      if (path === null) throw new Exit2(`error: parse ${s.line}`);
      edits.push((tree) => {
        safePath(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    const from = s.oldPath;
    const to = s.newPath ?? s.oldPath;
    if (from === null || to === null) throw new Exit2(`error: parse ${s.line}`);
    const move = from !== to;
    const hunks = s.hunks;
    edits.push((tree) => {
      safePath(from);
      safePath(to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (move && tree.exists(to)) throw new Fail('exists', to);
      const doc = splitDoc(before);
      let hay = doc.lines;
      let final = doc.final;
      let d = 0;
      for (const h of hunks) {
        const blk = hunkBlock(h.body);
        let at: number;
        let tier = 0;
        if (blk.oldLines.length === 0) {
          at = Math.max(0, Math.min(hay.length, h.a + d));
        } else {
          const m = matchTier(hay, blk.oldLines, STRICT);
          if (m.tier < 0) throw new Fail('no-match', from);
          tier = m.tier;
          at = nearest(m.where, h.a - 1 + d);
        }
        if (at + blk.oldLines.length === hay.length) final = !blk.noFinalBreak;
        hay = replaceAt(hay, at, blk.oldLines.length, blk, tier);
        d += blk.newLines.length - blk.oldLines.length;
      }
      const text = joinDoc(hay, doc.eol, hay.length === 0 ? false : final);
      if (move) {
        tree.now.set(from, null);
        tree.now.set(to, text);
        tree.moves.push({ from, to });
      } else {
        tree.now.set(to, text);
      }
    });
  }
  return edits;
}

/** The file a creation writes: the `+` lines of all its hunks, in order (section 6). */
function createdText(s: Section): string {
  const plus: string[] = [];
  let lastHasNoBreak = false;
  for (const h of s.hunks) {
    for (let k = 0; k < h.body.length; k += 1) {
      const { mark, text } = bodyLine(h.body[k]!);
      if (mark !== '+') continue;
      plus.push(text);
      lastHasNoBreak = k + 1 < h.body.length && bodyLine(h.body[k + 1]!).mark === '\\';
    }
  }
  return newFile(plus, !lastHasNoBreak);
}

// ── section 7: SEARCH/REPLACE blocks ──────────────────────────────────────

const isSearchLine = (l: string): boolean => rstrip(l) === '<<<<<<< SEARCH';
const isMidLine = (l: string): boolean => rstrip(l) === '=======';
const isReplaceLine = (l: string): boolean => rstrip(l) === '>>>>>>> REPLACE';

/** The path line of section 7: not blank and, trimmed, not starting with three backticks; else null. */
function srPath(line: string): string | null {
  const t = line.trim();
  if (t === '' || t.startsWith('```')) return null;
  return t;
}

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let blockStart = 0;
  while (i < lines.length) {
    if (!isSearchLine(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= blockStart; k -= 1) {
      const cand = srPath(lines[k]!);
      if (cand !== null) {
        path = cand;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let mid = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const l = lines[k]!;
      if (isSearchLine(l)) break;
      if (isReplaceLine(l)) {
        if (mid >= 0) end = k;
        break;
      }
      if (mid < 0 && isMidLine(l)) mid = k;
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      safePath(p);
      const before = tree.get(p);
      if (oldLines.length === 0) {
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, newFile(newLines));
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const doc = splitDoc(before);
      const m = matchTier(doc.lines, oldLines, STRICT);
      if (m.tier < 0) throw new Fail('no-match', p);
      if (m.where.length > 1) throw new Fail('ambiguous', p);
      const blk: Block = { oldLines, newLines, ctx: newLines.map(() => -1), noFinalBreak: false };
      const hay = replaceAt(doc.lines, m.where[0]!, oldLines.length, blk, m.tier);
      tree.now.set(p, joinDoc(hay, doc.eol, hay.length === 0 ? false : doc.final));
    });
    prevPath = path;
    blockStart = end + 1;
    i = end + 1;
  }
  return edits;
}

// ── section 8: V4A patches ────────────────────────────────────────────────

/** One chunk of an Update File section (section 8). */
interface Chunk {
  anchor: string | null;
  atEnd: boolean;
  blk: Block;
}

/** A line of a section, with its 1-based patch line number for faults. */
interface Line {
  text: string;
  no: number;
}

const isSectionLine = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    if (!isSectionLine(header)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i += 1;
    const body: Line[] = [];
    while (i < last && !isSectionLine(lines[i]!)) {
      body.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it (section 8).
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();

    if (header.startsWith('*** Add File: ')) {
      const path = header.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) content.push(b.text.slice(1));
        else if (b.text === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const text = newFile(content);
      edits.push((tree) => {
        safePath(path);
        if (tree.exists(path)) throw new Fail('exists', path);
        tree.now.set(path, text);
      });
      continue;
    }
    if (header.startsWith('*** Delete File: ')) {
      const path = header.slice('*** Delete File: '.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      edits.push((tree) => {
        safePath(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // `*** Update File: <path>` (section 8).
    const path = header.slice('*** Update File: '.length).trim();
    let k = 0;
    let move: string | null = null;
    if (k < body.length && body[k]!.text.startsWith('*** Move to: ')) {
      move = body[k]!.text.slice('*** Move to: '.length).trim();
      k += 1;
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    const open = (anchor: string | null): void => {
      cur = { anchor, atEnd: false, blk: { oldLines: [], newLines: [], ctx: [], noFinalBreak: false } };
      chunks.push(cur);
    };
    while (k < body.length) {
      const b = body[k]!;
      if (b.text.trim() === '*** End of File') {
        if (cur === null) open(null);
        (cur as Chunk).atEnd = true;
        k += 1;
        continue;
      }
      if (b.text.startsWith('@@')) {
        const anchor = b.text.slice(2).trim();
        open(anchor === '' ? null : anchor);
        k += 1;
        continue;
      }
      if (cur === null) {
        if (b.text === '' || b.text.startsWith(' ') || b.text.startsWith('-') || b.text.startsWith('+')) open(null);
        else throw new Exit2(`error: parse ${b.no}`);
      }
      const c = cur as Chunk;
      const t = b.text;
      if (t === '' || t[0] === ' ') {
        const text = t === '' ? '' : t.slice(1);
        c.blk.ctx.push(c.blk.oldLines.length);
        c.blk.oldLines.push(text);
        c.blk.newLines.push(text);
      } else if (t[0] === '-') {
        c.blk.oldLines.push(t.slice(1));
      } else if (t[0] === '+') {
        c.blk.ctx.push(-1);
        c.blk.newLines.push(t.slice(1));
      } else {
        throw new Exit2(`error: parse ${b.no}`);
      }
      k += 1;
    }
    if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${headerLine}`);
    const these = chunks;
    const to = move;
    edits.push((tree) => {
      safePath(path);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (to !== null) {
        safePath(to);
        if (tree.exists(to)) throw new Fail('exists', to);
      }
      const doc = splitDoc(before);
      let hay = doc.lines;
      const final = doc.final;
      let cursor = 0;
      const top = STRICT ? 0 : 2;
      for (const c of these) {
        if (c.anchor !== null) {
          let found = -1;
          for (let tier = 0; tier <= top && found < 0; tier += 1) {
            for (let q = cursor; q < hay.length; q += 1) {
              if (tierEq(hay[q]!, c.anchor, tier)) {
                found = q;
                break;
              }
            }
          }
          if (found < 0) throw new Fail('no-match', path);
          cursor = found + 1;
        }
        const b = c.blk;
        if (b.oldLines.length === 0) {
          const at = c.atEnd ? hay.length : Math.min(cursor, hay.length);
          hay = [...hay.slice(0, at), ...b.newLines, ...hay.slice(at)];
          cursor = at + b.newLines.length;
          continue;
        }
        let tier = -1;
        let starts: number[] = [];
        for (let t = 0; t <= top; t += 1) {
          starts = occurrencesAt(hay, b.oldLines, t).filter((x) => x >= cursor);
          if (c.atEnd) starts = starts.filter((x) => x + b.oldLines.length === hay.length);
          if (starts.length > 0) {
            tier = t;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const at = starts[0]!;
        hay = replaceAt(hay, at, b.oldLines.length, b, tier);
        cursor = at + b.newLines.length;
      }
      const text = joinDoc(hay, doc.eol, hay.length === 0 ? false : final);
      if (to !== null) {
        tree.now.set(path, null);
        tree.now.set(to, text);
        tree.moves.push({ from: path, to });
      } else {
        tree.now.set(path, text);
      }
    });
  }
  return edits;
}
// ── section 9: JSON edits ─────────────────────────────────────────────────

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    safePath(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      safePath(p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const doc = splitDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, joinDoc(lines, doc.eol, doc.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2(`error: parse ${first + 1}`);
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ── section 4: detecting the format ──────────────────────────────────────

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ── sections 1, 2 and 10: the command line, the output and the write ──────

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  STRICT = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (STRICT) return { code: 2, out: ['error: usage'] };
        STRICT = true;
      } else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else edits = unifiedEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      moved.set(m.to, m.from);
      movedFrom.add(m.from);
    }
  }
  const rows: { key: string; line: string }[] = [];
  const paths = [...new Set([...tree.now.keys()])];
  for (const p of paths) {
    if (movedFrom.has(p)) continue;
    if (moved.has(p)) {
      rows.push({ key: p, line: `R ${moved.get(p)!} -> ${p}` });
      continue;
    }
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (check) return { code: 0, out };
  // Every removal runs before every write, so deleting `foo` then creating `foo/a.txt` is clean.
  for (const p of paths) {
    if (tree.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
  }
  for (const p of paths) {
    const was = tree.original(p);
    const now = tree.get(p);
    if (now === null || was === now) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, now);
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
