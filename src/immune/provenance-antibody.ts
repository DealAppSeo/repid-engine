/**
 * immune/provenance-antibody.ts — mechanically reject a claim whose cited provenance does not resolve.
 *
 * THE FAILURE IT CLOSES [V 2026-11-03]. Three T12 research tasks were marked "done" and were fabricated:
 * trinity-chesed's SY-15 audit cited files like `src/engine/config.js:42` and `src/hal/verifier.js` — this repo
 * is 100% TypeScript (0 `.js` source files), so every one of those citations points at nothing. A human caught
 * it; a machine should have. This is the machine. Every cited `path[:line[-line]]` must RESOLVE — the file
 * exists inside the repo, the line is in range — and every cited VALUE must actually appear there, or the
 * citation is rejected. Un-collude-able: no amount of agreement between agents makes a nonexistent file exist.
 *
 * WHAT IT IS / IS NOT. This is the MECHANICAL half of the verification loop — the part a deterministic function
 * can settle with zero judgment. It proves a citation is GROUNDED (resolves + matches); it says nothing about
 * whether the grounded claim is correct, relevant, or complete — that is the independent agent's job. A citation
 * that resolves is necessary, never sufficient. Rejecting a bundle here means "the evidence is fabricated or
 * mis-cited"; passing here means only "the evidence exists as cited", not "the conclusion is right".
 *
 * PURE + INERT. The resolver (`resolveCitation`) is a pure function over a `FileView`; the IO wrapper
 * (`verifyCitations`) reads files under a FIXED repo root with path-escape protection and touches nothing else.
 * It writes no DB, moves no score, calls no network. A caller wires it into the verification loop and decides
 * what a rejection costs — this module only answers "does the cited provenance resolve?", fail-closed.
 *
 * TRUST BOUNDARY. Citations come from agents that may be fabricating, so a cited path is untrusted input: it is
 * resolved against the repo root and any path that escapes the root is refused (`path_escapes_root`) and never
 * read. The extractor is a best-effort front-end for free-text reports; the resolver is the ground truth, and a
 * caller holding structured evidence refs should feed `resolveCitation` directly rather than re-parse prose.
 */

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** A claim that something is at `path[:line[-endLine]]`, optionally that a given value appears there. */
export interface Citation {
  /** the citation as written, carried through to the report for the human/agent reviewer. */
  raw: string;
  /** repo-relative path the claim points at (untrusted — resolved under the repo root). */
  path: string;
  /** 1-based line the claim points at, or null for a whole-file citation. */
  line?: number | null;
  /** 1-based end line for a range citation; defaults to `line`. */
  endLine?: number | null;
  /** optional exact text the claim says is at that location (a quoted value, a symbol, a snippet). */
  expect?: string | null;
}

/** The file as the IO layer saw it — the only thing the pure resolver is allowed to look at. */
export interface FileView {
  /** true once the file was read successfully inside the repo root. */
  exists: boolean;
  /** number of lines (0 when the file is empty or unreadable). */
  lineCount: number;
  /** full file text ('' when !exists). */
  text: string;
  /** set when the cited path escaped the repo root — refused before any read. */
  escaped?: boolean;
}

export type Resolution =
  | { raw: string; path: string; resolved: true }
  | { raw: string; path: string; resolved: false; reason: string };

export interface AntibodyResult {
  /** citations examined. */
  checked: number;
  /** citations that resolved (file + line + value all hold). */
  resolved: number;
  /** the unresolved citations — the fabrication / mis-citation signals, each with a reason. */
  unresolved: Array<Extract<Resolution, { resolved: false }>>;
  /** true ⇒ every citation resolved. false ⇒ at least one does not — reject the bundle. */
  clean: boolean;
}

/** Strip ALL whitespace — the one deliberate corner: value matching ignores spacing and indentation (so a
 * re-indented or re-spaced quote like `foo( x )` still matches source `foo(x)`) but stays case- and
 * content-sensitive, because code is. Erring toward not false-rejecting an honest citation is deliberate:
 * punishing a true claim over formatting is the worst outcome. ponytail: whitespace-stripped substring; swap for
 * a tokenizer only if this lets a fabricated value slip through (content, not spacing, is what it still catches). */
const squash = (s: string): string => s.replace(/\s+/g, '');

const fmtAt = (c: Citation): string =>
  c.line == null ? c.path : c.endLine && c.endLine !== c.line ? `${c.path}:${c.line}-${c.endLine}` : `${c.path}:${c.line}`;

/**
 * Decide whether one citation resolves against the file the IO layer read. Pure, total, never throws.
 * A `false` result is the fabrication/mis-citation signal; its `reason` says which check failed.
 */
export function resolveCitation(c: Citation, file: FileView): Resolution {
  const at = fmtAt(c);
  const no = (reason: string): Resolution => ({ raw: c.raw, path: c.path, resolved: false, reason });

  if (file.escaped) return no(`path_escapes_root:${c.path}`);
  if (!file.exists) return no(`path_not_found:${c.path}`);

  if (c.line != null) {
    const start = c.line;
    const end = c.endLine ?? c.line;
    if (!Number.isInteger(start) || start < 1 || end < start || end > file.lineCount)
      return no(`line_out_of_range:${at} (file has ${file.lineCount} lines)`);
  }

  if (c.expect != null && c.expect !== '') {
    const hay =
      c.line == null ? file.text : file.text.split('\n').slice(c.line - 1, (c.endLine ?? c.line)).join('\n');
    if (!squash(hay).includes(squash(c.expect))) return no(`value_not_at_citation:${at}`);
  }

  return { raw: c.raw, path: c.path, resolved: true };
}

/** Join `rel` under `root`, refusing anything that escapes the root (path traversal / absolute paths). */
function safeJoin(root: string, rel: string): string | null {
  const abs = resolve(root, rel);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function readFileView(root: string, rel: string): FileView {
  const abs = safeJoin(root, rel);
  if (abs === null) return { exists: false, lineCount: 0, text: '', escaped: true };
  try {
    const text = readFileSync(abs, 'utf8');
    return { exists: true, lineCount: text === '' ? 0 : text.split('\n').length, text };
  } catch {
    return { exists: false, lineCount: 0, text: '' };
  }
}

/**
 * Resolve every citation against the real repo at `repoRoot`. Reads each distinct path at most once. Paths are
 * untrusted: anything escaping the root is refused and never read. Returns the fabrication signals in `unresolved`.
 */
export function verifyCitations(citations: Citation[], repoRoot: string): AntibodyResult {
  const root = resolve(repoRoot);
  const cache = new Map<string, FileView>();
  const load = (rel: string): FileView => {
    const hit = cache.get(rel);
    if (hit) return hit;
    const view = readFileView(root, rel);
    cache.set(rel, view);
    return view;
  };
  const resolutions = citations.map((c) => resolveCitation(c, load(c.path)));
  const unresolved = resolutions.filter((r): r is Extract<Resolution, { resolved: false }> => !r.resolved);
  return { checked: citations.length, resolved: resolutions.length - unresolved.length, unresolved, clean: unresolved.length === 0 };
}

/** code-ish extensions worth resolving; a bare `v1.0` / `0.886` / `README` is not a citation. */
const CITE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'sql', 'md', 'py', 'rs', 'go', 'sh', 'yml', 'yaml', 'toml',
]);

const CITE_RE = /([A-Za-z0-9_@./-]+\.[A-Za-z]{1,4})(?::(\d+)(?:-(\d+))?)?/g;

/**
 * Best-effort: pull `path[:line[-end]]` citations out of a free-text report. Conservative — a token is a citation
 * only if its extension is code-ish AND it carries either a path separator or an explicit line (so prose like
 * `v1.0` or `trinity.ai` is ignored). Heuristic by nature; `resolveCitation` is the ground truth. Deduped.
 */
export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITE_RE)) {
    const raw = m[0];
    const path = m[1];
    if (!path) continue;
    const line = m[2];
    const end = m[3];
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (!CITE_EXT.has(ext)) continue;
    if (!path.includes('/') && line == null) continue; // bare `foo.js` in prose, no location — skip
    const key = `${path}:${line ?? ''}:${end ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, path, line: line ? Number(line) : null, endLine: end ? Number(end) : null });
  }
  return out;
}
