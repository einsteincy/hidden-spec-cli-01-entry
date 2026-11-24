// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI
// edit format (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool
// calls), to SPEC.md v1. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Every sentence of SPEC.md is a requirement, so this file is written
// section by section from it: section 1 (invocation), 2 (output and exit
// codes), 3 (files, lines and paths), 4 (format detection), 5 (three-tier
// matching), 6 (unified diffs), 7 (SEARCH/REPLACE), 8 (V4A), 9 (JSON
// edits) and 10 (order and atomicity). The last lines hand a trial over
// to runner.ts when MAKEFUN_ENV_URL is set: keep that hand-over and
// runner.ts as the kit has them.

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
  /** The value a path has after the whole patch, whether or not it was touched. */
  final(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** What a parser needs from the run: strict matching, and the list of moves that succeeded, for the R output lines. */
interface Ctx {
  strict: boolean;
  moves: Array<[string, string]>;
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

// ---------------------------------------------------------------------------
// Section 3: a file as lines, its line break, and whether it ends with one.
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leading = (s: string): string => {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// ---------------------------------------------------------------------------
// Section 5: three-tier matching. O is found at the first tier where it
// occurs at least once; --strict tries tier 0 only.
// ---------------------------------------------------------------------------

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(tier, o[j], lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

function findTier(lines: string[], o: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** A single line (a V4A anchor) at or after `from`, at the first tier where one is. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (lineEq(t, anchor, lines[i]!)) return { tier: t, occ: [i] };
    }
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function buildNew(o: string[], n: NItem[], pos: number, fileLines: string[], tier: number): string[] {
  const out: string[] = [];
  const f = leading(fileLines[pos]!);
  const p = leading(o[0]!);
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oIdx]!);
    } else if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits (array form or JSON Lines).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyEl {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyEl[];
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** The path a `--- ` / `+++ ` line names, or null for /dev/null. */
function headerPath(raw: string): string | null {
  let t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = lines[at]!.match(HUNK_RE);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const hunk: Hunk = { a: Number(m[1]), body: [] };
  let i = at + 1;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ')) {
      hunk.body.push({ kind: 'ctx', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('-')) {
      hunk.body.push({ kind: 'old', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('+')) {
      hunk.body.push({ kind: 'new', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('\\')) {
      hunk.body.push({ kind: 'bs', text: l });
      i += 1;
    } else if (l === '') {
      hunk.body.push({ kind: 'ctx', text: '' });
      i += 1;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (hunk.body.length > 0) {
    const last = hunk.body[hunk.body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
    else break;
  }
  return { hunk, next: i };
}

/** Parse one section's header (before its first hunk) and its hunks; returns the index where the section ended. */
function parseSectionBody(lines: string[], start: number, sec: Section): number {
  let i = start;
  let inHeader = true;
  while (i < lines.length) {
    const l = lines[i]!;
    if (inHeader) {
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        sec.hunks.push(h.hunk);
        i = h.next;
        inHeader = false;
        continue;
      }
      if (isDiffGit(l)) return i;
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec.hasPair) return i;
          sec.hdrOld = headerPath(l.slice(4));
          sec.hdrNew = headerPath(lines[i + 1]!.slice(4));
          sec.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        if (!sec.hasPair) sec.hdrNew = headerPath(l.slice(4));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
    } else {
      if (isDiffGit(l)) return i;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        sec.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i += 1;
    }
  }
  return i;
}

function splitON(hunk: Hunk): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const el of hunk.body) {
    if (el.kind === 'ctx') {
      o.push(el.text);
      n.push({ text: el.text, ctx: true, oIdx: o.length - 1 });
    } else if (el.kind === 'old') {
      o.push(el.text);
    } else if (el.kind === 'new') {
      n.push({ text: el.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(hunk: Hunk): boolean {
  let idx = -1;
  for (let k = 0; k < hunk.body.length; k += 1) {
    if (hunk.body[k]!.kind === 'ctx' || hunk.body[k]!.kind === 'new') idx = k;
  }
  if (idx < 0) return false;
  return hunk.body[idx + 1]?.kind === 'bs';
}

/**
 * Apply one unified hunk to a file's state, in place. `d` is the sum over
 * this section's hunks applied so far of (N length minus O length).
 * Returns the hunk's own (N length minus O length). Throws Fail on no-match.
 */
function applyUnifiedHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, failPath: string): number {
  const { o, n } = splitON(hunk);
  const bs = backslashAfterLast(hunk);
  if (o.length > 0) {
    const found = findTier(state.lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', failPath);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const newLines = buildNew(o, n, pos, state.lines, found.tier);
    const touchesEnd = pos + o.length === state.lines.length;
    const newFinal = touchesEnd ? !bs : state.final;
    state.lines = [...state.lines.slice(0, pos), ...newLines, ...state.lines.slice(pos + o.length)];
    state.final = newFinal;
    return n.length - o.length;
  }
  const insertPos = Math.min(Math.max(hunk.a + d, 0), state.lines.length);
  const newLines = n.map((x) => x.text);
  const touchesEnd = insertPos === state.lines.length;
  const newFinal = touchesEnd ? !bs : state.final;
  state.lines = [...state.lines.slice(0, insertPos), ...newLines, ...state.lines.slice(insertPos)];
  state.final = newFinal;
  return n.length;
}

function unifiedEdit(sec: Section, ctx: Ctx): Edit {
  const oldP = sec.hasPair ? sec.hdrOld! : (sec.renOld ?? sec.diffOld ?? null);
  const newP = sec.hasPair ? sec.hdrNew! : (sec.hdrNew ?? sec.renNew ?? sec.diffNew ?? null);
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = !isCreate && (newP === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const np = newP;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]!.kind === 'new') {
            plus.push(h.body[k]!.text);
            lastPlusBs = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n');
      tree.now.set(np, text);
      return;
    }
    if (isDelete) {
      const op = oldP;
      if (op === null) throw new Fail('missing', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const state = parseFile(tree.get(op)!);
      let d = 0;
      for (const h of sec.hunks) d += applyUnifiedHunk(state, h, d, ctx.strict, op);
      tree.now.set(op, null);
      tree.now.set(np, serializeFile(state));
      ctx.moves.push([op, np]);
      return;
    }
    const p = oldP!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const state = parseFile(tree.get(p)!);
    let d = 0;
    for (const h of sec.hunks) d += applyUnifiedHunk(state, h, d, ctx.strict, p);
    tree.now.set(p, serializeFile(state));
  };
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const m = l.match(DIFF_GIT_RE);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        diffOld: m[1]!,
        diffNew: m[2]!,
        hdrOld: undefined,
        hdrNew: undefined,
        hasPair: false,
        renOld: null,
        renNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      i = parseSectionBody(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        diffOld: null,
        diffNew: null,
        hdrOld: headerPath(l.slice(4)),
        hdrNew: headerPath(lines[i + 1]!.slice(4)),
        hasPair: true,
        renOld: null,
        renNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      i = parseSectionBody(lines, i + 2, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, ctx));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (;;) {
    let sIdx = -1;
    for (let k = prevEnd; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = k;
        break;
      }
    }
    if (sIdx < 0) break;
    let path: string | null = null;
    for (let k = sIdx - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let eqIdx = -1;
    for (let k = sIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eqIdx = k;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const state = parseFile(cur);
      const found = findTier(state.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const items: NItem[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const newSeg = buildNew(oldLines, items, pos, state.lines, found.tier);
      state.lines = [...state.lines.slice(0, pos), ...newSeg, ...state.lines.slice(pos + oldLines.length)];
      tree.now.set(p, serializeFile(state));
    });
    prevPath = p;
    prevEnd = repIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEl[];
}
interface V4AHeader {
  kind: 'add' | 'delete' | 'update';
  path: string;
}

function v4aHeader(l: string): V4AHeader | null {
  if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice(13).trim() };
  if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice(16).trim() };
  if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice(16).trim() };
  return null;
}

function v4aEdit(hdr: V4AHeader, raw: string[], rawStart: number, startLine: number, ctx: Ctx): Edit {
  const path = hdr.path;
  if (hdr.kind === 'add') {
    const content: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l.startsWith('+')) content.push(l.slice(1));
      else if (l === '') content.push('');
      else throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    const text = content.length === 0 ? '' : content.join('\n') + '\n';
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (hdr.kind === 'delete') {
    for (let k = 0; k < raw.length; k += 1) {
      if (raw[k]!.trim() !== '') throw new Exit2(`error: parse ${rawStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File: optional Move to first, then chunks.
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
    moveTo = raw[0]!.slice(12).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let started = false;
  for (; idx < raw.length; idx += 1) {
    const line = raw[idx]!;
    const ln = rawStart + idx + 1;
    if (line.startsWith('@@')) {
      cur = { anchor: line.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      started = true;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (line.startsWith('*** ')) throw new Exit2(`error: parse ${ln}`);
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
        started = true;
      }
      if (line.startsWith(' ')) cur.body.push({ kind: 'ctx', text: line.slice(1) });
      else if (line.startsWith('-')) cur.body.push({ kind: 'old', text: line.slice(1) });
      else if (line.startsWith('+')) cur.body.push({ kind: 'new', text: line.slice(1) });
      else cur.body.push({ kind: 'ctx', text: '' });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  const newPath = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const state = parseFile(curText);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findSingle(state.lines, chunk.anchor, ctx.strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o: string[] = [];
      const n: NItem[] = [];
      for (const el of chunk.body) {
        if (el.kind === 'ctx') {
          o.push(el.text);
          n.push({ text: el.text, ctx: true, oIdx: o.length - 1 });
        } else if (el.kind === 'old') {
          o.push(el.text);
        } else if (el.kind === 'new') {
          n.push({ text: el.text, ctx: false, oIdx: -1 });
        }
      }
      if (chunk.eof) {
        if (o.length === 0) {
          const add = n.map((x) => x.text);
          state.lines = [...state.lines, ...add];
          cursor = state.lines.length;
        } else {
          const tiers = ctx.strict ? [0] : [0, 1, 2];
          let hit: TierHit | null = null;
          for (const t of tiers) {
            const occ = occurrences(state.lines, o, t, cursor).filter((p) => p + o.length === state.lines.length);
            if (occ.length > 0) {
              hit = { tier: t, occ };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', path);
          const pos = hit.occ[0]!;
          const newLines = buildNew(o, n, pos, state.lines, hit.tier);
          state.lines = [...state.lines.slice(0, pos), ...newLines];
          cursor = pos + newLines.length;
        }
      } else if (o.length === 0) {
        const add = n.map((x) => x.text);
        state.lines = [...state.lines.slice(0, cursor), ...add, ...state.lines.slice(cursor)];
        cursor += add.length;
      } else {
        const found = findTier(state.lines, o, ctx.strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const newLines = buildNew(o, n, pos, state.lines, found.tier);
        state.lines = [...state.lines.slice(0, pos), ...newLines, ...state.lines.slice(pos + o.length)];
        cursor = pos + newLines.length;
      }
    }
    const outText = serializeFile(state);
    if (newPath !== null) {
      tree.now.set(path, null);
      tree.now.set(newPath, outText);
      ctx.moves.push([path, newPath]);
    } else {
      tree.now.set(path, outText);
    }
  };
}

function parseV4A(lines: string[], ctx: Ctx): Edit[] {
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
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const hdr = v4aHeader(l);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i;
    i += 1;
    const rawStart = i;
    while (i < last && v4aHeader(lines[i]!) === null) i += 1;
    const raw = lines.slice(rawStart, i);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aEdit(hdr, raw, rawStart, startLine, ctx));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1 and 2: invocation, output and exit codes. Section 10: order
// and atomicity — edits apply in patch order, a failed edit changes
// nothing, the edits after it still run, and when any edit failed no file
// is written.
// ---------------------------------------------------------------------------

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
  const moves: Array<[string, string]> = [];
  const ctx: Ctx = { strict, moves };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, ctx);
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
  // Output rows, in byte order of the paths. A successful move replaces its
  // D and A lines with one R line, sorted by the new path; each move edit is
  // checked on its own old and new paths against the patch's before/after.
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.final(o) === null && tree.original(n) === null && tree.final(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (suppressed.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
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
