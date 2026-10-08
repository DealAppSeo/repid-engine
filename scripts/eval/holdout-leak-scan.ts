/**
 * HOLDOUT LEAK SCAN: the mechanical half of "git holds edges and hashes only" (S60, 2026-10-07).
 *
 * Hashes every candidate sentence in every committed (and every untracked, not-ignored) file the
 * same way the manifest hashes a private claim (normalizeClaim + sha256), and reports which
 * watched hashes it found and where. tests/holdout-leak-guard.test.ts watches every
 * eval/holdout/manifest.jsonl claim_sha256: a hit means private holdout text is in the tree.
 * holdout-rotate.ts watches new items before registering them: a hit means the sentence is already
 * public, so it cannot be a holdout item.
 *
 * WHAT A CANDIDATE IS (the F-2 inventory's extraction, widened): every string value of a JSON or
 * JSONL document, every line of every text file, every quoted literal on a line ("...", '...',
 * `...`, SQL's '' escape included), and each of those split into markdown table cells, sentences
 * and the text after a short "label:" prefix. Candidates shorter than MIN_CLAIM_CHARS are skipped:
 * a holdout claim is refused under that length.
 *
 * WHAT IT CANNOT SEE, said plainly: a paraphrase, a claim broken across lines, or a claim inside a
 * longer sentence that none of the splits isolate. Hash matching finds copies, not rewordings.
 * Binary files and files over MAX_FILE_BYTES are skipped and counted.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { MAX_CLAIM_CHARS, MIN_CLAIM_CHARS, normalizeClaim, sha256Hex } from './holdout';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.wasm', '.woff', '.woff2', '.ttf',
  '.otf', '.mp4', '.mp3', '.bin', '.so', '.dylib', '.dll', '.exe', '.jar', '.class', '.sqlite', '.db',
]);

export interface ScanResult {
  /** Text files read. */
  files: number;
  /** Binary, oversized or unreadable files skipped. */
  skipped: number;
  /** Distinct normalized candidates hashed, summed over files. */
  candidates: number;
  /** Files read, per extension. */
  byExt: Record<string, number>;
  /** Watched hash -> the files it was found in. */
  hits: Map<string, string[]>;
}

function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${root}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** Tracked files plus untracked files git does not ignore: what the next commit could contain. */
export function repoFiles(root: string): string[] {
  const tracked = git(root, ['ls-files', '-z']).split('\0');
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.|'')*)'|`((?:[^`\\]|\\.)*)`/g;

function unescape(s: string): string {
  return s
    .replace(/''/g, "'")
    .replace(/\\(["'`\\])/g, '$1')
    .replace(/\\[nrt]/g, ' ');
}

function* pieces(s: string): Generator<string> {
  yield s;
  const colon = s.indexOf(': ');
  if (colon > 0 && colon < 40) yield s.slice(colon + 2);
  yield s.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '');
  const cells = s.includes('|') ? s.split('|') : [s];
  for (const cell of cells) {
    if (cells.length > 1) yield cell;
    const sentences = cell.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1) for (const sent of sentences) yield sent;
  }
}

function* jsonStrings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* jsonStrings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) yield* jsonStrings(x);
}

/** Every raw candidate string in one file's text. Exported so a test can see what is extracted. */
export function* candidates(rel: string, text: string): Generator<string> {
  const ext = extname(rel).toLowerCase();
  if (ext === '.json') {
    try {
      for (const s of jsonStrings(JSON.parse(text))) yield* pieces(s);
    } catch {
      /* not valid JSON: the line pass below still reads it */
    }
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (ext === '.jsonl' || ext === '.ndjson') {
      try {
        for (const s of jsonStrings(JSON.parse(line))) yield* pieces(s);
      } catch {
        /* not a JSON line */
      }
    }
    yield* pieces(line);
    for (const m of line.matchAll(LITERAL)) {
      const lit = m[1] ?? m[2] ?? m[3];
      if (lit) yield* pieces(unescape(lit));
    }
  }
}

/** Normalized candidates of one file, deduplicated, inside the claim length bounds. */
export function normalizedCandidates(rel: string, text: string): Set<string> {
  const out = new Set<string>();
  for (const c of candidates(rel, text)) {
    if (c.length < MIN_CLAIM_CHARS) continue;
    const n = normalizeClaim(c);
    if (n.length >= MIN_CLAIM_CHARS && n.length <= MAX_CLAIM_CHARS) out.add(n);
  }
  return out;
}

/**
 * Scan `files` (relative to root) for the watched hashes. Every candidate is hashed; only watched
 * hashes are kept, so memory does not grow with the tree.
 */
export function scanFiles(root: string, files: readonly string[], watch: ReadonlySet<string>): ScanResult {
  const res: ScanResult = { files: 0, skipped: 0, candidates: 0, byExt: {}, hits: new Map() };
  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      res.skipped += 1;
      continue;
    }
    let buf: Buffer;
    try {
      const abs = join(root, rel);
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) {
        res.skipped += 1;
        continue;
      }
      buf = readFileSync(abs);
    } catch {
      res.skipped += 1;
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      res.skipped += 1;
      continue;
    }
    res.files += 1;
    res.byExt[ext || '(none)'] = (res.byExt[ext || '(none)'] ?? 0) + 1;
    const norm = normalizedCandidates(rel, buf.toString('utf8'));
    res.candidates += norm.size;
    for (const n of norm) {
      const h = sha256Hex(n);
      if (!watch.has(h)) continue;
      const where = res.hits.get(h) ?? [];
      where.push(rel);
      res.hits.set(h, where);
    }
  }
  return res;
}

/** Scan the whole repository (what the next commit could contain) for the watched hashes. */
export function scanRepo(root: string, watch: ReadonlySet<string>): ScanResult {
  return scanFiles(root, repoFiles(root), watch);
}
