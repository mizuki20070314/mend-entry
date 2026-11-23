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

// ---- Section 3: a file's lines and breaks ----

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ---- Section 5: matching lines at three tiers ----

type BLKind = 'ctx' | 'old' | 'new';

interface BL {
  kind: BLKind;
  text: string;
  noNl: boolean;
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchAt(O: string[], file: string[], at: number, tier: number): boolean {
  if (at < 0 || at + O.length > file.length) return false;
  for (let j = 0; j < O.length; j += 1) {
    if (normLine(O[j]!, tier) !== normLine(file[at + j]!, tier)) return false;
  }
  return true;
}

/** The first tier with an occurrence; `eof` restricts to an occurrence ending at the last line. */
function findOcc(O: string[], file: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const pos: number[] = [];
    if (eof) {
      const at = file.length - O.length;
      if (at >= from && matchAt(O, file, at, tier)) pos.push(at);
    } else {
      for (let i = Math.max(0, from); i + O.length <= file.length; i += 1) {
        if (matchAt(O, file, i, tier)) pos.push(i);
      }
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** Turn a body into its old lines, new lines and, for each new line, its old-line index when it is a context line. */
function bodyON(body: BL[]): { O: string[]; N: string[]; map: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const map: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'ctx') {
      map.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else {
      N.push(b.text);
      map.push(null);
    }
  }
  return { O, N, map };
}

/** The lines that replace file[at .. at+O.length): context uses the file's bytes; tier 2 re-indents. */
function replacedLines(firstOld: string, N: string[], map: (number | null)[], file: string[], at: number, tier: number): string[] {
  const F = leading(file[at] ?? '');
  const P = leading(firstOld);
  return N.map((s, j) => {
    const oi = map[j];
    if (oi !== null && oi !== undefined) return file[at + oi] ?? s;
    if (tier === 2 && s.trim() !== '' && s.startsWith(P)) return F + s.slice(P.length);
    return s;
  });
}

/** The `\ No newline at end of file` flag on the hunk's last context or new line. */
function lastNoNl(body: BL[]): boolean {
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const b = body[j]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.noNl;
  }
  return false;
}

// ---- Section 6: unified diffs ----

interface UHunk {
  A: number;
  body: BL[];
}

interface USection {
  old: string | null;
  new: string | null;
  oldNull: boolean;
  newNull: boolean;
  create: boolean;
  del: boolean;
  gitOld: string | null;
  gitNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  headerPaths: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function barePath(s: string): string {
  const p = s.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function diffPath(line: string, cut: number): { path: string | null; isNull: boolean } {
  const p = line.slice(cut).split('\t')[0]!.trim();
  if (p === '/dev/null') return { path: null, isNull: true };
  return { path: barePath(p), isNull: false };
}

function newSection(): USection {
  return {
    old: null, new: null, oldNull: false, newNull: false, create: false, del: false,
    gitOld: null, gitNew: null, renameOld: null, renameNew: null, headerPaths: false, hunks: [],
  };
}

function isBareSection(line: string, lines: string[], i: number): boolean {
  return line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = newSection();
      cur.gitOld = barePath(m[1]!);
      cur.gitNew = barePath(m[2]!);
      inHeader = true;
      i += 1;
      continue;
    }
    if (isBareSection(line, lines, i)) {
      if (!inHeader || cur!.headerPaths) {
        if (cur !== null) sections.push(cur);
        cur = newSection();
        inHeader = true;
      }
      const o = diffPath(line, 4);
      const n = diffPath(lines[i + 1]!, 4);
      cur!.old = o.path;
      cur!.new = n.path;
      cur!.oldNull = o.isNull;
      cur!.newNull = n.isNull;
      cur!.headerPaths = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@') && cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('--- ') && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (cur === null) {
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const h: UHunk = { A: Number(hm[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || isBareSection(b, lines, i)) break;
        if (b === '') {
          h.body.push({ kind: 'ctx', text: '', noNl: false });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          h.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: b.slice(1), noNl: false });
          i += 1;
          continue;
        }
        if (c === '\\') {
          if (h.body.length > 0) h.body[h.body.length - 1]!.noNl = true;
          i += 1;
          continue;
        }
        break;
      }
      while (h.body.length > 0 && h.body[h.body.length - 1]!.kind === 'ctx' && h.body[h.body.length - 1]!.text === '') h.body.pop();
      cur.hunks.push(h);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = diffPath(line, 12).path;
      else if (line.startsWith('rename to ')) cur.renameNew = diffPath(line, 10).path;
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    // Between hunks: prose, code fences and other lines are ignored.
    i += 1;
  }
  if (cur !== null) sections.push(cur);

  const edits: Edit[] = [];
  for (const s of sections) {
    const old = s.old ?? s.renameOld ?? s.gitOld;
    const neu = s.new ?? s.renameNew ?? s.gitNew;
    if (old === null && neu === null) continue;
    const create = s.create || s.oldNull;
    const del = s.del || s.newNull;
    const o = old;
    const n = neu;
    const hs = s.hunks;
    edits.push((tree) => {
      for (const q of [o, n]) if (q !== null && !safe(q)) throw new Fail('unsafe', q);
      if (create) {
        if (n === null) throw new Fail('missing', o ?? '');
        if (tree.get(n) !== null) throw new Fail('exists', n);
        const out: string[] = [];
        let noNl = false;
        for (const h of hs) {
          for (const b of h.body) if (b.kind === 'new') {
            out.push(b.text);
            noNl = b.noNl;
          }
        }
        tree.now.set(n, out.length === 0 ? '' : out.join('\n') + (noNl ? '' : '\n'));
      } else if (del) {
        if (o === null) throw new Fail('missing', n ?? '');
        if (tree.get(o) === null) throw new Fail('missing', o);
        tree.now.set(o, null);
      } else if (o === null || n === null) {
        throw new Fail('missing', o ?? n ?? '');
      } else {
        const before = tree.get(o);
        if (before === null) throw new Fail('missing', o);
        if (o !== n && tree.get(n) !== null) throw new Fail('exists', n);
        const { br, lines: fl, final } = fileParts(before);
        let work = fl.slice();
        let curFinal = final;
        let d = 0;
        for (const h of hs) {
          const { O, N, map } = bodyON(h.body);
          const noNl = lastNoNl(h.body);
          const len = work.length;
          if (O.length === 0) {
            let at = h.A + d;
            if (at < 0) at = 0;
            if (at > work.length) at = work.length;
            work.splice(at, 0, ...N);
            if (at === len) curFinal = noNl ? false : true;
          } else {
            const found = findOcc(O, work, strict, 0, false);
            if (found === null) throw new Fail('no-match', o);
            const want = h.A - 1 + d;
            let best = found.pos[0]!;
            for (const p of found.pos) if (Math.abs(p - want) < Math.abs(best - want)) best = p;
            const repl = replacedLines(O[0]!, N, map, work, best, found.tier);
            work.splice(best, O.length, ...repl);
            if (best + O.length === len) curFinal = noNl ? false : true;
          }
          d += N.length - O.length;
        }
        const result = joinFile(work, br, curFinal);
        if (o !== n) {
          tree.now.set(n, result);
          tree.now.set(o, null);
          tree.moves.push([o, n]);
        } else tree.now.set(o, result);
      }
    });
  }
  return edits;
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastEnd = 0;
  let lastPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = lastEnd; k < searchLine; k += 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) path = t;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let rep = -1;
    for (let k = searchLine + 1; k < lines.length; k += 1) {
      if (eq < 0) {
        if (lines[k]!.trimEnd() === '=======') eq = k;
      } else if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    const map: (number | null)[] = newLines.map(() => null);
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: fl, final } = fileParts(before);
      const found = findOcc(oldLines, fl, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const repl = replacedLines(oldLines[0]!, newLines, map, fl, at, found.tier);
      const out = fl.slice(0, at).concat(repl, fl.slice(at + oldLines.length));
      tree.now.set(p, joinFile(out, br, final));
    });
    lastPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BL[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i += 1;
    const body: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();

    if (kind === 'add') {
      const out: string[] = [];
      for (const b of body) {
        if (b.text === '') out.push('');
        else if (b.text.startsWith('+')) out.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.num}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, out.length === 0 ? '' : out.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }

    let bi = 0;
    let moveTo: string | null = null;
    if (body.length > 0 && body[0]!.text.startsWith('*** Move to: ')) {
      moveTo = body[0]!.text.slice(13).trim();
      bi = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let chunkCount = 0;
    for (; bi < body.length; ) {
      const b = body[bi]!;
      const t = b.text;
      if (t.trim() === '*** End of File') {
        if (cur === null) {
          cur = { anchor: null, eof: true, body: [] };
          chunkCount += 1;
        } else cur.eof = true;
        bi += 1;
        continue;
      }
      if (t.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
        chunkCount += 1;
        bi += 1;
        continue;
      }
      if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (cur === null) {
          if (chunkCount > 0) throw new Exit2(`error: parse ${b.num}`);
          cur = { anchor: null, eof: false, body: [] };
          chunkCount += 1;
        }
        const k: BLKind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
        cur.body.push({ kind: k, text: t === '' ? '' : t.slice(1), noNl: false });
        bi += 1;
        continue;
      }
      throw new Exit2(`error: parse ${b.num}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);

    const p = path;
    const mv = moveTo;
    const cs = chunks;
    edits.push((tree) => {
      for (const q of [p, mv]) if (q !== null && !safe(q)) throw new Fail('unsafe', q);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      const { br, lines: fl, final } = fileParts(before);
      let work = fl.slice();
      let cursor = 0;
      for (const ch of cs) {
        if (ch.anchor !== null) {
          let found = -1;
          for (const tier of strict ? [0] : [0, 1, 2]) {
            for (let k = cursor; k < work.length; k += 1) {
              if (normLine(ch.anchor, tier) === normLine(work[k]!, tier)) {
                found = k;
                break;
              }
            }
            if (found >= 0) break;
          }
          if (found < 0) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const { O, N, map } = bodyON(ch.body);
        if (O.length > 0) {
          const found = findOcc(O, work, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          const at = found.pos[0]!;
          const repl = replacedLines(O[0]!, N, map, work, at, found.tier);
          work.splice(at, O.length, ...repl);
          cursor = at + repl.length;
        } else {
          const at = ch.eof ? work.length : Math.min(cursor, work.length);
          const repl = replacedLines('', N, map, work, at, 0);
          work.splice(at, 0, ...repl);
          cursor = at + repl.length;
        }
      }
      const result = joinFile(work, br, final);
      if (mv !== null) {
        tree.now.set(mv, result);
        tree.now.set(p, null);
        tree.moves.push([p, mv]);
      } else tree.now.set(p, result);
    });
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : kind === 'v4a' ? v4aEdits(lines, strict)
      : [];
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
  const movePairs = tree.moves.filter(([o, n]) =>
    tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null);
  const movedPaths = new Set(movePairs.flatMap(([o, n]) => [o, n]));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedPaths.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [o, n] of movePairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
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
