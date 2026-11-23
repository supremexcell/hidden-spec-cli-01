// main.ts is mend, the CLI SPEC.md specifies: it applies an AI-written edit
// (unified diff, SEARCH/REPLACE block, V4A patch or JSON tool calls) to a tree
// of text files, all or nothing. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// Sections of SPEC.md implemented here: 1 (invocation), 2 (output and exit
// codes), 3 (files, lines and paths), 4 (format detection), 5 (three-tier
// line matching with tier-2 re-indentation), 6 (unified diffs, hunks picked
// nearest their stated line number), 7 (SEARCH/REPLACE blocks), 8 (V4A
// patches, cursor plus anchor), 9 (JSON edits) and 10 (order and atomicity).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
}

/** A file split into lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.fin ? st.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in `file` at `tier` (occurrences may overlap). */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const on = o.map((x) => normLine(x, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in `file` at or after `from`, with its positions. */
function findTier(file: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(file, o, t).filter((i) => i >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctx` >= 0 names the O line it is a context line of, -1 a plain new line. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * Replace the k matched lines at `pos` by N. A context line is written as
 * the file's own matched line; at tier 2 every other non-blank line of N
 * that starts with O's first line's leading whitespace has that prefix
 * replaced by the file's first matched line's leading whitespace.
 */
function applyReplace(file: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = leadWs(file[pos]!);
  const p = leadWs(o[0]!);
  const rep = n.map((nl) => {
    if (nl.ctx >= 0) return file[pos + nl.ctx]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
  return [...file.slice(0, pos), ...rep, ...file.slice(pos + o.length)];
}

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

type Edit = (tree: Tree) => void;

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noeol: boolean;
  /** A `\` line follows the hunk's last `+` line, or null when it has none. */
  plusNoeol: boolean | null;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null | undefined;
  renameNew: string | null | undefined;
  diffOld: string | null | undefined;
  diffNew: string | null | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after four characters, to the first tab, trimmed; /dev/null is null. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  const parseErr = (lineNo: number): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+?) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m === null) parseErr(i + 1);
      cur = {
        pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined,
        diffOld: m[1]!, diffNew: m[2]!, newFileMode: false, deletedFileMode: false, hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = {
        pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!),
        renameOld: undefined, renameNew: undefined, diffOld: undefined, diffNew: undefined,
        newFileMode: false, deletedFileMode: false, hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) parseErr(i + 2);
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i++;
        continue;
      }
      if (!line.startsWith('@@')) {
        i++;
        continue;
      }
      // A hunk header in the header falls through below.
    }
    if (line.startsWith('@@')) {
      if (cur === null) parseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) parseErr(i + 1);
      const a = Number(m[1]);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push(l);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const nn: NLine[] = [];
      for (const l of body) {
        if (l.startsWith(' ')) {
          const t = l.slice(1);
          o.push(t);
          nn.push({ text: t, ctx: o.length - 1 });
        } else if (l.startsWith('-')) {
          o.push(l.slice(1));
        } else if (l.startsWith('+')) {
          nn.push({ text: l.slice(1), ctx: -1 });
        } else if (l === '') {
          o.push('');
          nn.push({ text: '', ctx: o.length - 1 });
        }
        // A `\` line refers to the body line before it; only the ones after
        // the last context/`+` line (noeol) or the last `+` line (plusNoeol)
        // change anything, and those are read below.
      }
      let noeol = false;
      let plusNoeol: boolean | null = null;
      for (let k = body.length - 1; k >= 0; k--) {
        const l = body[k]!;
        if (l.startsWith(' ') || l.startsWith('+')) {
          noeol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
          break;
        }
      }
      for (let k = body.length - 1; k >= 0; k--) {
        const l = body[k]!;
        if (l.startsWith('+')) {
          plusNoeol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
          break;
        }
      }
      cur.hunks.push({ a, o, n: nn, noeol, plusNoeol });
      inHeader = false;
      i = j;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  let oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  let newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  const isCreate = sec.newFileMode || oldP === null;
  const isDelete = sec.deletedFileMode || (!isCreate && newP === null);
  const kind: 'create' | 'delete' | 'move' | 'change' = isCreate
    ? 'create'
    : isDelete
      ? 'delete'
      : oldP !== newP
        ? 'move'
        : 'change';
  return (tree) => {
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    if (kind === 'create') {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noeol = false;
      for (const h of sec.hunks) {
        for (const nl of h.n) if (nl.ctx < 0) plus.push(nl.text);
        if (h.plusNoeol !== null) noeol = h.plusNoeol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const ins = Math.min(Math.max(h.a + d, 0), st.lines.length);
        const atEnd = ins === st.lines.length;
        const rep = h.n.map((nl) => nl.text);
        st.lines = [...st.lines.slice(0, ins), ...rep, ...st.lines.slice(ins)];
        if (atEnd && rep.length > 0) st.fin = !h.noeol;
        d += h.n.length;
      } else {
        const found = findTier(st.lines, h.o, strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const q of found.pos) {
          const dd = Math.abs(q - target);
          if (dd < bestDist) {
            best = q;
            bestDist = dd;
          }
        }
        const runsToEnd = best + h.o.length === st.lines.length;
        st.lines = applyReplace(st.lines, best, h.o, h.n, found.tier);
        if (runsToEnd) st.fin = !h.noeol;
        d += h.n.length - h.o.length;
      }
    }
    const text = joinFile(st);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      tree.moves.push([p, newP!]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let gt = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (eq < 0 || gt < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, gt);
    edits.push(((p, o, nw) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      const found = findTier(st.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const nlines: NLine[] = nw.map((t) => ({ text: t, ctx: -1 }));
      st.lines = applyReplace(st.lines, found.pos[0]!, o, nlines, found.tier);
      tree.now.set(p, joinFile(st));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = gt;
    i = gt + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function chunkFromBody(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: -1 });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    }
  }
  return { o, n };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          i++;
        } else if (l.trim() === '') {
          // A whitespace-only line is an empty line of the file; one at
          // the end of the section is stripped below as a blank line.
          body.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(((p, b) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.length === 0 ? '' : b.join('\n') + '\n');
      })(path, body));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < end) {
        const l = lines[i]!;
        if (blank(l)) {
          i++;
          continue;
        }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(((p) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: { anchor: string | null; body: string[]; eof: boolean } | null = null;
      const flush = (atSectionEnd: boolean): void => {
        if (curChunk === null) return;
        const body = curChunk.body;
        if (atSectionEnd) {
          while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
        }
        const { o, n } = chunkFromBody(body);
        chunks.push({ anchor: curChunk.anchor, o, n, eof: curChunk.eof });
        curChunk = null;
      };
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (curChunk === null) {
          if (l === '') {
            i++;
            continue;
          }
          if (l.trim() === '' && chunks.length > 0) {
            i++;
            continue;
          }
        }
        if (l.startsWith('@@')) {
          flush(false);
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          flush(false);
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, body: [], eof: false };
          }
          curChunk.body.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(((p, mv, chs) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const st = splitFile(before);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null) {
            const af = findTier(st.lines, [ch.anchor], strict, cursor);
            if (af === null) throw new Fail('no-match', p);
            cursor = af.pos[0]! + 1;
          }
          if (ch.o.length === 0) {
            const ins = ch.eof ? st.lines.length : cursor;
            const rep = ch.n.map((nl) => nl.text);
            st.lines = [...st.lines.slice(0, ins), ...rep, ...st.lines.slice(ins)];
            cursor = ins + rep.length;
          } else {
            let found: { tier: number; pos: number } | null = null;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              const occ = occurrences(st.lines, ch.o, t).filter(
                (q) => q >= cursor && (!ch.eof || q + ch.o.length === st.lines.length),
              );
              if (occ.length > 0) {
                found = { tier: t, pos: occ[0]! };
                break;
              }
            }
            if (found === null) throw new Fail('no-match', p);
            st.lines = applyReplace(st.lines, found.pos, ch.o, ch.n, found.tier);
            cursor = found.pos + ch.n.length;
          }
        }
        const text = joinFile(st);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, text);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, text);
        }
      })(path, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per changed path, in byte order of the path; a successful move
  // whose old path existed before the patch and is gone after it, and whose
  // new path did not exist before it and does after it, is one `R` line
  // sorting by its new path instead of the pair's `D` and `A` lines.
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (usedOld.has(oldP) || usedNew.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
