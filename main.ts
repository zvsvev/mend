// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful move edits, as [old, new] pairs, for the R output lines (section 2). */
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

// ---- Section 5: three-tier line matching, and the file line model (section 3) ----

function leadWS(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}
function parseFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}
function writeFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}
function occurrences(F: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(F[i + k]!, O[k]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function tierOf(F: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(F, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** Replace O (matched at position i in F) by N. Context lines (ctx[j] !== null) are written as the file's own
 * matched line; at tier 2 every other line is re-indented from O's first line's leading whitespace to the file's. */
function replaceAt(F: string[], i: number, O: string[], N: string[], ctx: (number | null)[], tier: number): string[] {
  const P = O.length > 0 ? leadWS(O[0]!) : '';
  const Flead = i < F.length ? leadWS(F[i]!) : '';
  const rep: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const c = ctx[j];
    if (c !== null && c !== undefined) {
      rep.push(F[i + c]!);
    } else {
      let line = N[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) {
        line = Flead + line.slice(P.length);
      }
      rep.push(line);
    }
  }
  return [...F.slice(0, i), ...rep, ...F.slice(i + O.length)];
}

// ---- Section 6: unified diffs ----

interface Hunk {
  A: number;
  O: string[];
  N: string[];
  ctx: (number | null)[];
  noNL: boolean;
  plusNoNL: boolean;
}

function buildHunk(A: number, body: string[]): Hunk {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: (number | null)[] = [];
  for (const l of body) {
    if (l === '') {
      O.push('');
      N.push('');
      ctx.push(O.length - 1);
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push(t);
      ctx.push(O.length - 1);
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push(l.slice(1));
      ctx.push(null);
    }
  }
  let noNL = false;
  let plusNoNL = false;
  let lastN = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') { lastN = k; break; }
  }
  if (lastN >= 0 && body[lastN + 1] !== undefined && body[lastN + 1]![0] === '\\') noNL = true;
  let lastP = -1;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]![0] === '+') { lastP = k; break; }
  }
  if (lastP >= 0 && body[lastP + 1] !== undefined && body[lastP + 1]![0] === '\\') plusNoNL = true;
  return { A, O, N, ctx, noNL, plusNoNL };
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const pathOf = (l: string): string => {
    let t = l.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  interface Raw {
    dashOld?: string;
    dashNew?: string;
    renameOld?: string;
    renameNew?: string;
    diffOld?: string;
    diffNew?: string;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  let inHeader = false;
  let hasDash = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = l.slice('diff --git '.length).match(/^a\/(.*?) b\/(.*)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      raws.push(cur);
      inHeader = true;
      hasDash = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nextPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (inHeader && cur !== null && !hasDash) {
        if (!nextPlus) throw new Exit2(`error: parse ${i + 2}`);
        cur.dashOld = pathOf(l);
        cur.dashNew = pathOf(lines[i + 1]!);
        hasDash = true;
        i += 2;
        continue;
      }
      if (nextPlus) {
        cur = { dashOld: pathOf(l), dashNew: pathOf(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] };
        raws.push(cur);
        inHeader = true;
        hasDash = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') { body.push(b); j++; } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(A, body));
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  const sections: UniSection[] = raws.map((r) => {
    const oldRaw = r.dashOld !== undefined ? r.dashOld : r.renameOld !== undefined ? r.renameOld : r.diffOld;
    const newRaw = r.dashNew !== undefined ? r.dashNew : r.renameNew !== undefined ? r.renameNew : r.diffNew;
    const oldPath = oldRaw === undefined ? null : oldRaw === '/dev/null' ? null : r.dashOld !== undefined ? stripAB(oldRaw) : oldRaw;
    const newPath = newRaw === undefined ? null : newRaw === '/dev/null' ? null : r.dashNew !== undefined ? stripAB(newRaw) : newRaw;
    return { oldPath, newPath, isCreate: r.isCreate, isDelete: r.isDelete, hunks: r.hunks };
  });
  return sections.map((sec) => {
    return (tree: Tree) => {
      const isCreate = sec.isCreate || sec.oldPath === null;
      const isDelete = !isCreate && (sec.isDelete || sec.newPath === null);
      if (isCreate) {
        const p = sec.newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        for (const h of sec.hunks) {
          for (let j = 0; j < h.N.length; j++) {
            if (h.ctx[j] === null) out.push(h.N[j]!);
          }
        }
        let fin = true;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.N.some((_, j) => h.ctx[j] === null)) { fin = !h.plusNoNL; break; }
        }
        tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = sec.oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const isMove = sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
      const p = sec.oldPath ?? sec.newPath!;
      if (isMove) {
        if (!safe(sec.oldPath!)) throw new Fail('unsafe', sec.oldPath!);
        if (!safe(sec.newPath!)) throw new Fail('unsafe', sec.newPath!);
      } else if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (isMove && tree.get(sec.newPath!) !== null) throw new Fail('exists', sec.newPath!);
      const f = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.O.length === 0) {
          const oldLen = f.lines.length;
          const at = Math.min(h.A + d, oldLen);
          f.lines.splice(at, 0, ...h.N);
          if (at === oldLen) f.final = !h.noNL;
          d += h.N.length;
        } else {
          const found = tierOf(f.lines, h.O, strict);
          if (found === null) throw new Fail('no-match', p);
          const target = h.A - 1 + d;
          let best = found.occ[0]!;
          let bestDist = Math.abs(best - target);
          for (const pos of found.occ) {
            const dist = Math.abs(pos - target);
            if (dist < bestDist) { best = pos; bestDist = dist; }
          }
          const runsToEnd = best + h.O.length === f.lines.length;
          f.lines = replaceAt(f.lines, best, h.O, h.N, h.ctx, found.tier);
          if (runsToEnd) f.final = !h.noNL;
          d += h.N.length - h.O.length;
        }
      }
      const out = writeFile(f.lines, f.br, f.final);
      if (isMove) {
        tree.now.set(sec.oldPath!, null);
        tree.now.set(sec.newPath!, out);
        tree.moves.push([sec.oldPath!, sec.newPath!]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq === -1) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
      if (end === -1) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end) });
      prevPath = path;
      prevEnd = end + 1;
      i = end + 1;
    } else {
      i++;
    }
  }
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const f = parseFile(before);
      const found = tierOf(f.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const ctx: (number | null)[] = b.newLines.map(() => null);
      f.lines = replaceAt(f.lines, found.occ[0]!, b.oldLines, b.newLines, ctx, found.tier);
      tree.now.set(b.path, writeFile(f.lines, f.br, f.final));
    };
  });
}

// ---- Section 8: V4A patches ----

interface V4AChunk {
  anchor: string | null;
  O: string[];
  N: string[];
  ctx: (number | null)[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const endIdx = last;
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < endIdx) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < endIdx) {
        const s = lines[j]!;
        if (!blank(s) && isSectionStart(s)) break;
        if (!blank(s) && !s.startsWith('+')) throw new Exit2(`error: parse ${j + 1}`);
        secLines.push(s);
        j++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
      const fileLines = secLines.map((s) => (s.startsWith('+') ? s.slice(1) : ''));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      let j = i + 1;
      while (j < endIdx && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < endIdx && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      // The section runs to the next section start or *** End Patch; blank lines at its end are not part of it.
      let secEnd = j;
      while (secEnd < endIdx && !isSectionStart(lines[secEnd]!)) secEnd++;
      while (secEnd > j && blank(lines[secEnd - 1]!)) secEnd--;
      const chunks: V4AChunk[] = [];
      let k = j;
      let firstChunk = true;
      while (k < secEnd) {
        while (k < secEnd && blank(lines[k]!)) k++;
        if (k >= secEnd) break;
        const s = lines[k]!;
        if (isSectionStart(s)) break;
        let anchor: string | null = null;
        if (s.startsWith('@@')) {
          anchor = s.slice(2).trim();
          k++;
        } else if (!firstChunk) {
          throw new Exit2(`error: parse ${k + 1}`);
        }
        const body: string[] = [];
        let eof = false;
        while (k < secEnd) {
          const b = lines[k]!;
          if (b.startsWith('@@')) break;
          if (b.trim() === '*** End of File') { eof = true; k++; break; }
          if (isSectionStart(b)) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') { body.push(b); k++; } else throw new Exit2(`error: parse ${k + 1}`);
        }
        const O: string[] = [];
        const N: string[] = [];
        const ctx: (number | null)[] = [];
        for (const bl of body) {
          if (bl === '') { O.push(''); N.push(''); ctx.push(O.length - 1); } else if (bl[0] === ' ') {
            const t = bl.slice(1);
            O.push(t);
            N.push(t);
            ctx.push(O.length - 1);
          } else if (bl[0] === '-') O.push(bl.slice(1));
          else if (bl[0] === '+') { N.push(bl.slice(1)); ctx.push(null); }
        }
        chunks.push({ anchor, O, N, ctx, eof });
        firstChunk = false;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = parseFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const a = tierOf(f.lines, [ch.anchor], strict, cursor);
            if (a === null) throw new Fail('no-match', path);
            cursor = a.occ[0]! + 1;
          }
          if (ch.O.length === 0) {
            const at = ch.eof ? f.lines.length : cursor;
            f.lines.splice(at, 0, ...ch.N);
            cursor = at + ch.N.length;
          } else {
            const found = tierOf(f.lines, ch.O, strict, cursor);
            if (found === null) throw new Fail('no-match', path);
            let occ = found.occ;
            if (ch.eof) {
              occ = occ.filter((pos) => pos + ch.O.length === f.lines.length);
              if (occ.length === 0) throw new Fail('no-match', path);
            }
            const at = occ[0]!;
            f.lines = replaceAt(f.lines, at, ch.O, ch.N, ch.ctx, found.tier);
            cursor = at + ch.N.length;
          }
        }
        const out = writeFile(f.lines, f.br, f.final);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, out);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, out);
        }
      });
      i = secEnd;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!suppressed.has(p)) entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
