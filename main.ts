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

/** A file as lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line as a tier sees it (SPEC.md section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Positions where O occurs in the file's lines at one tier (overlaps allowed). */
function findOccurrences(fileLines: string[], o: string[], tier: number): number[] {
  const occ: number[] = [];
  if (o.length === 0) return occ;
  const no = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(fileLines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

/** The first tier at which O occurs at least once, or null. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    const occ = findOccurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One replacement: old lines O, new lines N; nCtx[j] is the index into O when N[j] is a context line, else null. */
interface Replace {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

/** Splice a replacement into the file's lines at one occurrence (SPEC.md section 5). */
function spliceReplace(fileLines: string[], rep: Replace, occ: number, tier: number): string[] {
  const out = fileLines.slice(0, occ);
  const f = leadingWs(fileLines[occ] ?? '');
  const p = rep.o.length > 0 ? leadingWs(rep.o[0]!) : '';
  for (let j = 0; j < rep.n.length; j += 1) {
    const ci = rep.nCtx[j];
    if (ci !== null && ci !== undefined) {
      out.push(fileLines[occ + ci]!);
    } else {
      let line = rep.n[j]!;
      if (tier === 2 && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
      out.push(line);
    }
  }
  out.push(...fileLines.slice(occ + rep.o.length));
  return out;
}

/** Apply one Replace to a file's lines at its chosen occurrence; returns the new lines. */
function applyReplaceAt(fileLines: string[], rep: Replace, occ: number, tier: number): string[] {
  return spliceReplace(fileLines, rep, occ, tier);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

/** One unified hunk (SPEC.md section 6). */
interface Hunk {
  a: number;
  rep: Replace;
  trailingNoEol: boolean;
  lastPlusNoEol: boolean;
  plus: string[];
}

function parseDiffPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse one hunk body starting at lines[i] (an @@ line); returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
  if (head === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(head[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  const plus: string[] = [];
  const isCtxOrPlus: boolean[] = [];
  const isPlus: boolean[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      const idx = o.length;
      o.push(text);
      n.push(text);
      nCtx.push(idx);
      isCtxOrPlus.push(true);
      isPlus.push(false);
    } else if (l[0] === '-') {
      o.push(l.slice(1));
      isCtxOrPlus.push(false);
      isPlus.push(false);
    } else if (l[0] === '+') {
      const text = l.slice(1);
      n.push(text);
      nCtx.push(null);
      plus.push(text);
      isCtxOrPlus.push(true);
      isPlus.push(true);
    } else {
      isCtxOrPlus.push(false);
      isPlus.push(false);
    }
  }
  let trailingNoEol = false;
  let lastPlusNoEol = false;
  for (let k = isCtxOrPlus.length - 1; k >= 0; k -= 1) {
    if (isCtxOrPlus[k]) {
      trailingNoEol = body[k + 1] !== undefined && body[k + 1]![0] === '\\';
      break;
    }
  }
  for (let k = isPlus.length - 1; k >= 0; k -= 1) {
    if (isPlus[k]) {
      lastPlusNoEol = body[k + 1] !== undefined && body[k + 1]![0] === '\\';
      break;
    }
  }
  return { hunk: { a, rep: { o, n, nCtx }, trailingNoEol, lastPlusNoEol, plus }, next: j };
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.rep.o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      f.lines = f.lines.slice(0, at).concat(h.rep.n, f.lines.slice(at));
      if (at === f.lines.length) f.final = !h.trailingNoEol;
    } else {
      const found = findTier(f.lines, h.rep.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const atEnd = best + h.rep.o.length === f.lines.length;
      f.lines = spliceReplace(f.lines, h.rep, best, found.tier);
      if (atEnd) f.final = !h.trailingNoEol;
    }
    d += h.rep.n.length - h.rep.o.length;
  }
  return joinFile(f);
}

/** Parse a unified diff patch into one edit per section (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Section {
    diffOld: string | null;
    diffNew: string | null;
    dashOld: string | null;
    dashNew: string | null;
    hasDashPair: boolean;
    renameFrom: string | null;
    renameTo: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
  }
  const newSection = (): Section => ({
    diffOld: null,
    diffNew: null,
    dashOld: null,
    dashNew: null,
    hasDashPair: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  const sections: Section[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasDashPair) {
        cur.dashOld = parseDiffPath(line.slice(4));
        cur.dashNew = parseDiffPath(lines[i + 1]!.slice(4));
        cur.hasDashPair = true;
      } else {
        cur = newSection();
        cur.dashOld = parseDiffPath(line.slice(4));
        cur.dashNew = parseDiffPath(lines[i + 1]!.slice(4));
        cur.hasDashPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i);
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldPath = sec.hasDashPair ? sec.dashOld : sec.renameFrom ?? sec.diffOld;
    const newPath = sec.hasDashPair ? sec.dashNew : sec.renameTo ?? sec.diffNew;
    const isCreate = sec.isCreate || oldPath === null;
    const isDelete = sec.isDelete || newPath === null;
    const hunks = sec.hunks;
    if (isCreate && newPath !== null) {
      const np = newPath;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let noEol = false;
        for (const h of hunks) {
          plus.push(...h.plus);
          if (h.plus.length > 0) noEol = h.lastPlusNoEol;
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      });
    } else if (isDelete && oldPath !== null) {
      const op = oldPath;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      const op = oldPath;
      const np = newPath;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const after = applyHunks(before, hunks, strict, op);
        tree.now.set(np, after);
        tree.now.set(op, null);
        tree.moves.push([op, np]);
      });
    } else if (oldPath !== null && newPath !== null) {
      const p = oldPath;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        tree.now.set(p, applyHunks(before, hunks, strict, p));
      });
    } else {
      edits.push(() => {});
    }
  }
  return edits;
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

/** Parse SEARCH/REPLACE blocks into one edit per block (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let e = -1;
    for (let k = s + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        e = k;
        break;
      }
    }
    let r = -1;
    if (e >= 0) {
      for (let k = e + 1; k < n; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          r = k;
          break;
        }
      }
    }
    if (e < 0 || r < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const rep: Replace = { o: oldLines, n: newLines, nCtx: newLines.map(() => null) };
      f.lines = spliceReplace(f.lines, rep, found.occ[0]!, found.tier);
      tree.now.set(p, joinFile(f));
    });
    prevEnd = r;
    prevPath = p;
    i = r + 1;
  }
  return edits;
}

/** Parse a V4A patch into one edit per section (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
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
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      i += 1;
      while (i < end && !isSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new Exit2(`error: parse ${first + 1 + k + 1}`);
      }
      const path = p;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < end && !isSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      const path = p;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      while (i < end && blank(lines[i]!)) i += 1;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const raw: string[] = [];
      while (i < end && !isSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      interface Chunk {
        anchor: string | null;
        rep: Replace;
        eof: boolean;
      }
      const chunks: Chunk[] = [];
      let cur: { anchor: string | null; o: string[]; n: string[]; nCtx: (number | null)[]; eof: boolean } | null = null;
      let chunkStarted = false;
      const finish = (): void => {
        if (cur !== null) {
          chunks.push({ anchor: cur.anchor, rep: { o: cur.o, n: cur.n, nCtx: cur.nCtx }, eof: cur.eof });
          cur = null;
        }
      };
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          finish();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], nCtx: [], eof: false };
          chunkStarted = true;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${updateLine + 1 + k}`);
          cur.eof = true;
          finish();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunkStarted) throw new Exit2(`error: parse ${updateLine + 1 + k}`);
            cur = { anchor: null, o: [], n: [], nCtx: [], eof: false };
            chunkStarted = true;
          }
          if (l === '' || l[0] === ' ') {
            const text = l === '' ? '' : l.slice(1);
            const idx = cur.o.length;
            cur.o.push(text);
            cur.n.push(text);
            cur.nCtx.push(idx);
          } else if (l[0] === '-') {
            cur.o.push(l.slice(1));
          } else {
            cur.n.push(l.slice(1));
            cur.nCtx.push(null);
          }
          continue;
        }
        throw new Exit2(`error: parse ${updateLine + 1 + k}`);
      }
      finish();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const path = p;
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundAt = -1;
            for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
              for (let k = cursor; k < f.lines.length; k += 1) {
                if (normLine(f.lines[k]!, t) === normLine(ch.anchor!, t)) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', path);
            cursor = foundAt + 1;
          }
          if (ch.rep.o.length === 0) {
            const at = ch.eof ? f.lines.length : cursor;
            f.lines = f.lines.slice(0, at).concat(ch.rep.n, f.lines.slice(at));
            cursor = at + ch.rep.n.length;
          } else {
            let found: { tier: number; occ: number } | null = null;
            for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
              const occs = findOccurrences(f.lines, ch.rep.o, t).filter(
                (pos) => pos >= cursor && (!ch.eof || pos + ch.rep.o.length === f.lines.length),
              );
              if (occs.length > 0) {
                found = { tier: t, occ: occs[0]! };
                break;
              }
            }
            if (found === null) throw new Fail('no-match', path);
            f.lines = spliceReplace(f.lines, ch.rep, found.occ, found.tier);
            cursor = found.occ + ch.rep.n.length;
          }
        }
        const after = joinFile(f);
        if (mt !== null) {
          tree.now.set(mt, after);
          tree.now.set(path, null);
          tree.moves.push([path, mt]);
        } else {
          tree.now.set(path, after);
        }
      });
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
  const moveSet = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      moveSet.set(newP, oldP);
    }
  }
  const movedOld = new Set<string>([...moveSet.values()]);
  const rows: string[] = [];
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p)) continue;
    if (moveSet.has(p)) rows.push(`R ${moveSet.get(p)} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of changed) {
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
