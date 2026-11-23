// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as
// JSON — to a tree of text files, to SPEC.md. Every file is changed or none:
// a failed edit is reported and nothing is written. Lines are matched at
// three tiers (exact, trailing whitespace, both-side whitespace) unless
// --strict asks for exact only. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

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

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier reads it: 0 exact, 1 trailing spaces and tabs off, 2 both sides off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
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
  move(oldP: string, newP: string): void {
    this.moves.set(newP, oldP);
  }
}

type Edit = (tree: Tree) => void;

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

/** Where old lines O occur in a file's lines, at the first tier with any occurrence. */
interface Occ {
  tier: number;
  positions: number[];
}

function findOccurrences(o: string[], lines: string[], strict: boolean, from = 0, endAtLast = false): Occ | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (endAtLast && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to an anchor, at the first tier with one. */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, tier) === normLine(anchor, tier)) return i;
    }
  }
  return null;
}

/** One body line: `ctx` (context), `del` (old only), `add` (new only). */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/**
 * The lines that replace a matched occurrence. A context line is written as
 * the file's own matched line, never the patch's. At tier 2 every other new
 * line that starts with the old first line's leading whitespace has that
 * prefix replaced by the file's first matched line's leading whitespace.
 */
function replacement(items: BodyItem[], fileLines: string[], pos: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2) {
    p = leadingWs(oFirst);
    f = leadingWs(fileLines[pos] ?? '');
  }
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

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
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(f));
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

/** One unified hunk: its old start line and its body, with `\` line notes. */
interface Hunk {
  a: number;
  items: BodyItem[];
  noFinal: boolean;
  addNoFinal: boolean;
  hasAdd: boolean;
}

function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks to a file's text, in order. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  let f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    for (const it of h.items) if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const ins = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !h.noFinal;
      d += ins.length;
      continue;
    }
    const occ = findOccurrences(o, f.lines, strict);
    if (occ === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = occ.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of occ.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const beforeLen = f.lines.length;
    const rep = replacement(h.items, f.lines, best, occ.tier, o[0]!);
    f.lines.splice(best, o.length, ...rep);
    if (best + o.length === beforeLen) f.final = !h.noFinal;
    d += rep.length - o.length;
  }
  return renderFile(f);
}

/** Read a unified diff (SPEC.md section 6) into its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Section {
    headerOld?: string | null;
    headerNew?: string | null;
    renameOld?: string | null;
    renameNew?: string | null;
    gitOld?: string | null;
    gitNew?: string | null;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
    firstHunkLine: number;
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = { create: false, del: false, hunks: [], firstHunkLine: 0 };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.headerOld === undefined) {
        cur.headerOld = headerPath(l);
        cur.headerNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const s = newSection();
      s.headerOld = headerPath(l);
      s.headerNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur.hunks.length === 0) cur.firstHunkLine = i + 1;
      const a = Number(m[1]);
      i += 1;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BodyItem[] = [];
      for (const b of raw) {
        if (b === '') items.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) items.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) items.push({ kind: 'del', text: b.slice(1) });
        else if (b.startsWith('+')) items.push({ kind: 'add', text: b.slice(1) });
      }
      let noFinal = false;
      let addNoFinal = false;
      let hasAdd = false;
      for (let k = raw.length - 1; k >= 0; k--) {
        const b = raw[k]!;
        if (b.startsWith('+')) {
          hasAdd = true;
          addNoFinal = (raw[k + 1] ?? '').startsWith('\\');
          break;
        }
      }
      for (let k = raw.length - 1; k >= 0; k--) {
        const b = raw[k]!;
        if (b === '' || b.startsWith(' ') || b.startsWith('+')) {
          noFinal = (raw[k + 1] ?? '').startsWith('\\');
          break;
        }
      }
      cur.hunks.push({ a, items, noFinal, addNoFinal, hasAdd });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.headerOld !== undefined ? s.headerOld : s.renameOld !== undefined ? s.renameOld : s.gitOld;
    const newP = s.headerNew !== undefined ? s.headerNew : s.renameNew !== undefined ? s.renameNew : s.gitNew;
    if (oldP === undefined && newP === undefined) {
      if (s.hunks.length > 0) throw new Exit2(`error: parse ${s.firstHunkLine}`);
      continue;
    }
    if (oldP === null && newP === null) continue;
    const isCreate = (oldP === null || s.create) && newP !== null && newP !== undefined;
    const isDelete = !isCreate && (newP === null || s.del) && oldP !== null && oldP !== undefined;
    const isMove = !isCreate && !isDelete && oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const target = newP!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const plus: string[] = [];
        let noFinal = false;
        for (const h of hunks) {
          for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
          if (h.hasAdd) noFinal = h.addNoFinal;
        }
        tree.now.set(target, plus.length === 0 ? '' : `${plus.join('\n')}${noFinal ? '' : '\n'}`);
      });
    } else if (isDelete) {
      const target = oldP!;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
    } else if (isMove) {
      const oldPath = oldP!;
      const newPath = newP!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(text, hunks, strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.move(oldPath, newPath);
      });
    } else {
      const target = (oldP ?? newP)!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        const text = tree.get(target);
        if (text === null) throw new Fail('missing', target);
        tree.now.set(target, applyHunks(text, hunks, strict, target));
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into their edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    let k = eq + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let p = i - 1; p >= prevEnd; p--) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const f = parseFile(text);
    const occ = findOccurrences(b.oldLines, f.lines, strict);
    if (occ === null) throw new Fail('no-match', b.path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = occ.positions[0]!;
    const items: BodyItem[] = b.newLines.map((t) => ({ kind: 'add' as const, text: t }));
    const rep = replacement(items, f.lines, pos, occ.tier, b.oldLines[0]!);
    f.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, renderFile(f));
  });
}

/** Read a V4A patch (SPEC.md section 8) into its sections' edits. */
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
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const collected: { text: string; plus: boolean }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('+')) collected.push({ text: b.slice(1), plus: true });
        else if (b.trim() === '') collected.push({ text: '', plus: false });
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (collected.length > 0 && !collected[collected.length - 1]!.plus) collected.pop();
      const addLines = collected.map((c) => c.text);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, addLines.length === 0 ? '' : `${addLines.join('\n')}\n`);
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      interface RawChunk {
        anchor: string | null;
        eof: boolean;
        raw: string[];
      }
      const rawChunks: RawChunk[] = [];
      let curRaw: RawChunk | null = null;
      const finishRaw = (): void => {
        if (curRaw === null) return;
        while (curRaw.raw.length > 0 && curRaw.raw[curRaw.raw.length - 1]!.trim() === '') curRaw.raw.pop();
        rawChunks.push(curRaw);
        curRaw = null;
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b === '*** End of File') {
          if (curRaw === null) throw new Exit2(`error: parse ${i + 1}`);
          curRaw.eof = true;
          finishRaw();
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          finishRaw();
          const anchor = b.slice(2).trim();
          curRaw = { anchor: anchor === '' ? null : anchor, eof: false, raw: [] };
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.trim() === '') {
          if (curRaw === null) {
            if (rawChunks.length === 0) {
              curRaw = { anchor: null, eof: false, raw: [] };
            } else if (b.trim() === '') {
              i += 1;
              continue;
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          curRaw.raw.push(b);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finishRaw();
      if (rawChunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      interface Chunk {
        anchor: string | null;
        eof: boolean;
        items: BodyItem[];
      }
      const chunks: Chunk[] = rawChunks.map((rc) => {
        const items: BodyItem[] = [];
        for (const b of rc.raw) {
          if (b === '') items.push({ kind: 'ctx', text: '' });
          else if (b.startsWith(' ')) items.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) items.push({ kind: 'del', text: b.slice(1) });
          else if (b.startsWith('+')) items.push({ kind: 'add', text: b.slice(1) });
          else items.push({ kind: 'ctx', text: '' });
        }
        return { anchor: rc.anchor, eof: rc.eof, items };
      });
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = parseFile(text);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const hit = findAnchor(ch.anchor, f.lines, cursor, strict);
            if (hit === null) throw new Fail('no-match', path);
            cursor = hit + 1;
          }
          const o: string[] = [];
          for (const it of ch.items) if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
          if (o.length === 0) {
            const insPos = ch.eof ? f.lines.length : cursor;
            const ins = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
            f.lines.splice(insPos, 0, ...ins);
            cursor = insPos + ins.length;
            continue;
          }
          const occ = findOccurrences(o, f.lines, strict, cursor, ch.eof);
          if (occ === null) throw new Fail('no-match', path);
          const pos = occ.positions[0]!;
          const rep = replacement(ch.items, f.lines, pos, occ.tier, o[0]!);
          f.lines.splice(pos, o.length, ...rep);
          cursor = pos + rep.length;
        }
        const out = renderFile(f);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.move(path, moveTo);
        } else {
          tree.now.set(path, out);
        }
      });
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
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  const oldToNew = new Map<string, string>();
  for (const [newP, oldP] of tree.moves) oldToNew.set(oldP, newP);
  for (const [newP, oldP] of tree.moves) {
    let finalNew = newP;
    const seen = new Set<string>([oldP]);
    while (oldToNew.has(finalNew) && !seen.has(finalNew)) {
      seen.add(finalNew);
      finalNew = oldToNew.get(finalNew)!;
    }
    if (oldP === finalNew) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(finalNew) === null && tree.get(finalNew) !== null) {
      rows.push({ key: finalNew, text: `R ${oldP} -> ${finalNew}` });
      covered.add(oldP);
      covered.add(finalNew);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
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
