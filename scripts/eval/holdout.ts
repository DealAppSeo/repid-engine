/**
 * PRIVATE ROTATING HOLDOUT (Sean, BUS S60, 2026-10-07):
 *   "Replace with a private rotating set, edges and hashes only, checker pair recorded."
 *
 * GIT HOLDS NO TEXT AND NO LABEL. eval/holdout/manifest.jsonl has one row per item:
 *
 *   item_id       our own id
 *   claim_sha256  sha256 of the NORMALIZED claim (normalizeClaim). Unsalted on purpose: the leak
 *                 guard (tests/holdout-leak-guard.test.ts) hashes every sentence in committed files
 *                 the same way and fails on any match, which is how private text entering git is
 *                 caught. So a claim anyone can guess exactly is a claim anyone can find here:
 *                 write fresh sentences, never public benchmark rows.
 *   label_commit  sha256("holdout-label-v1\n" + item_id + "\n" + label + "\n" + normalized claim).
 *                 Pins the label without publishing it: without the private text the label cannot
 *                 be recovered, and a later relabel of the private copy fails verification.
 *   edges         the records the label was decided on, in the answer-key record shape minus
 *                 `snapshot` and `outcome`: { kind?, locator?, url, sha256 }. NO direction. Whether
 *                 a record supports or contradicts the claim IS the label, so it stays private.
 *   checker_pair  the checker families that last scored the item ({ families, status, run_id,
 *                 measured_at }); null until measured. One family is 'incomplete' (F2 ledger rule).
 *   rotation      the rotation the item entered in
 *   retire_after  YYYY-MM-DD; after it the item no longer counts and holdout-rotate.ts retires it
 *   retired_at    YYYY-MM-DD or null
 *
 * WHY THE LABEL IS NOT IN GIT. A public label beside an unsalted claim hash is an answer key for
 * anyone who can enumerate candidate sentences: hash every sentence of a source, look the hashes up
 * here, read the answers. That is the retired set's leak in a different encoding. With the label
 * committed only as label_commit, a guessed sentence reveals membership, not the answer.
 *
 * WHERE THE TEXT LIVES, in this order:
 *   1. HOLDOUT_FILE: a local JSONL the operator keeps, one { item_id, claim, label, edges? } per line.
 *      Refused if it sits inside this repository without being gitignored (*.holdout.private.jsonl
 *      and eval/holdout/private/ are). Named but missing is NOT_CHECKED; it never falls through to
 *      another source the operator did not name.
 *   2. The checker ledger: ledger_items where holdout = true (service key only; RLS is on with no
 *      policies). Its migration may not be applied; a missing table is NOT_CHECKED, said by name.
 *   3. Neither: NOT_CHECKED (exit 2), naming both. Never a quiet pass, and never the retired public
 *      sets (scripts/eval/retired-holdout.ts).
 *
 * Every active manifest row must be in the private source with a matching claim hash and label
 * commitment, and every private item must be registered. Anything else is a HoldoutIntegrityError
 * (exit 1) that names item ids, never text.
 *
 *   npx ts-node scripts/eval/holdout.ts verify     # counts only; exit 0 VERIFIED, 1 FAILED, 2 NOT_CHECKED
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { modelFamily } from '../../src/classify/free-votes';

export const REPO_ROOT = resolve(__dirname, '..', '..');
export const MANIFEST_PATH = join(REPO_ROOT, 'eval', 'holdout', 'manifest.jsonl');
export const LEDGER_MIGRATION = 'supabase/migrations/20261006150000_checker_ledger.sql';
/** A claim shorter than this is not a sentence; the leak scan skips candidates under it. */
export const MIN_CLAIM_CHARS = 12;
export const MAX_CLAIM_CHARS = 600;

export type Label = 'TRUE' | 'FALSE';
export type PairStatus = 'complete' | 'incomplete';

export interface Edge {
  kind?: string;
  locator?: string;
  url: string;
  sha256: string;
}

export interface CheckerPairRecord {
  families: string[];
  checkers?: string[];
  status: PairStatus;
  run_id: string;
  measured_at: string;
}

export interface ManifestRow {
  item_id: string;
  claim_sha256: string;
  label_commit: string;
  edges: Edge[];
  checker_pair: CheckerPairRecord | null;
  rotation: string;
  retire_after: string;
  retired_at: string | null;
}

/** A private row. Lives in HOLDOUT_FILE or ledger_items, never in git. */
export interface PrivateItem {
  item_id: string;
  claim: string;
  label: Label;
  /** Private edges carry their direction: { relation: 'supports' | 'contradicts', ...Edge }. */
  edges?: Array<Edge & { relation?: string }>;
}

export interface VerifiedItem {
  item_id: string;
  claim: string;
  label: Label;
}

export class HoldoutIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutIntegrityError';
  }
}

export class HoldoutNotCheckedError extends Error {
  readonly missing: string[];
  constructor(reason: string, missing: string[]) {
    super(`NOT_CHECKED: ${reason}`);
    this.name = 'HoldoutNotCheckedError';
    this.missing = missing;
  }
}

/** 0 VERIFIED, 1 FAILED, 2 NOT_CHECKED. A missing source never shares an exit code with a pass. */
export function exitCodeFor(err: unknown): number {
  return err instanceof HoldoutNotCheckedError ? 2 : 1;
}

// ---- hashing ----------------------------------------------------------------------------------

const EDGE_CHARS = /^[\s"'`*_~>#|.,;:!?()[\]{}<-]+|[\s"'`*_~>#|.,;:!?()[\]{}<-]+$/g;

/**
 * The form a claim is hashed in. Case, whitespace, curly quotes and edge punctuation or markdown do
 * not make a different sentence, so `**The Moon is made of rock.**` and `the moon is made of rock`
 * hash the same. Generous on purpose: the leak guard would rather over-match than miss.
 */
export function normalizeClaim(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(EDGE_CHARS, '')
    .trim();
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function claimSha256(claim: string): string {
  return sha256Hex(normalizeClaim(claim));
}

export function labelCommit(itemId: string, label: Label, claim: string): string {
  return sha256Hex(`holdout-label-v1\n${itemId}\n${label}\n${normalizeClaim(claim)}`);
}

// ---- manifest ---------------------------------------------------------------------------------

const ROW_KEYS = ['item_id', 'claim_sha256', 'label_commit', 'edges', 'checker_pair', 'rotation', 'retire_after', 'retired_at'] as const;
const EDGE_KEYS = new Set(['kind', 'locator', 'url', 'sha256']);
const PAIR_KEYS = new Set(['families', 'checkers', 'status', 'run_id', 'measured_at']);
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_ID = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * Parse and validate the committed manifest. A key outside the schema fails, so a `claim`, `text`,
 * `label` or an edge `relation` can never ride into git inside a manifest row.
 */
export function parseManifest(text: string, where = 'eval/holdout/manifest.jsonl'): ManifestRow[] {
  const rows: ManifestRow[] = [];
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const at = `${where}:${i + 1}`;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new HoldoutIntegrityError(`${at} is not JSON`);
    }
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new HoldoutIntegrityError(`${at} is not an object`);
    const extra = Object.keys(r).filter((k) => !(ROW_KEYS as readonly string[]).includes(k));
    if (extra.length) {
      throw new HoldoutIntegrityError(`${at} has keys outside the manifest schema (${extra.join(', ')}); text and labels stay out of git`);
    }
    const missing = ROW_KEYS.filter((k) => !(k in r));
    if (missing.length) throw new HoldoutIntegrityError(`${at} is missing ${missing.join(', ')}`);
    const id = r['item_id'];
    if (typeof id !== 'string' || !ITEM_ID.test(id)) throw new HoldoutIntegrityError(`${at} item_id is not an id`);
    if (ids.has(id)) throw new HoldoutIntegrityError(`${at} repeats item_id ${id}`);
    ids.add(id);
    for (const k of ['claim_sha256', 'label_commit'] as const) {
      if (typeof r[k] !== 'string' || !HEX64.test(r[k] as string)) throw new HoldoutIntegrityError(`${at} ${k} is not a sha256 hex`);
    }
    const ch = r['claim_sha256'] as string;
    if (hashes.has(ch)) throw new HoldoutIntegrityError(`${at} (${id}) repeats a claim hash already in the manifest`);
    hashes.add(ch);
    if (!Array.isArray(r['edges'])) throw new HoldoutIntegrityError(`${at} edges is not an array`);
    for (const e of r['edges'] as unknown[]) {
      const edge = (e ?? {}) as Record<string, unknown>;
      const bad = Object.keys(edge).filter((k) => !EDGE_KEYS.has(k));
      if (bad.length) {
        throw new HoldoutIntegrityError(
          `${at} (${id}) edge has ${bad.join(', ')}; an edge in git is { kind?, locator?, url, sha256 } — its direction is the label and stays private`,
        );
      }
      if (typeof edge['url'] !== 'string' || !/^https?:\/\/\S+$/.test(edge['url'])) throw new HoldoutIntegrityError(`${at} (${id}) edge url is not absolute`);
      if (typeof edge['sha256'] !== 'string' || !HEX64.test(edge['sha256'])) throw new HoldoutIntegrityError(`${at} (${id}) edge sha256 is not a sha256 hex`);
      for (const k of ['kind', 'locator'] as const) {
        if (k in edge && (typeof edge[k] !== 'string' || (edge[k] as string).length > 200)) throw new HoldoutIntegrityError(`${at} (${id}) edge ${k} is not a short string`);
      }
    }
    const cp = r['checker_pair'];
    if (cp !== null) {
      const p = (cp ?? {}) as Record<string, unknown>;
      const bad = Object.keys(p).filter((k) => !PAIR_KEYS.has(k));
      if (typeof cp !== 'object' || bad.length || !Array.isArray(p['families']) || !['complete', 'incomplete'].includes(p['status'] as string)) {
        throw new HoldoutIntegrityError(`${at} (${id}) checker_pair is not { families, checkers?, status, run_id, measured_at }`);
      }
    }
    if (typeof r['rotation'] !== 'string' || !(r['rotation'] as string).trim() || (r['rotation'] as string).length > 64) {
      throw new HoldoutIntegrityError(`${at} (${id}) rotation is not a short id`);
    }
    if (typeof r['retire_after'] !== 'string' || !DAY.test(r['retire_after'])) throw new HoldoutIntegrityError(`${at} (${id}) retire_after is not YYYY-MM-DD`);
    if (r['retired_at'] !== null && (typeof r['retired_at'] !== 'string' || !DAY.test(r['retired_at']))) {
      throw new HoldoutIntegrityError(`${at} (${id}) retired_at is not null or YYYY-MM-DD`);
    }
    rows.push(r as unknown as ManifestRow);
  });
  return rows;
}

/** One line per row, keys in schema order, so a rotation shows as a clean diff. */
export function serializeManifest(rows: readonly ManifestRow[]): string {
  return rows
    .map((r) => {
      const o: Record<string, unknown> = {};
      for (const k of ROW_KEYS) o[k] = r[k];
      return JSON.stringify(o);
    })
    .map((l) => `${l}\n`)
    .join('');
}

export function readManifest(path: string = MANIFEST_PATH): ManifestRow[] {
  if (!existsSync(path)) throw new HoldoutIntegrityError(`${path} does not exist`);
  return parseManifest(readFileSync(path, 'utf8'), relative(REPO_ROOT, path) || path);
}

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Counts: not retired and not past retire_after. */
export function isActive(r: ManifestRow, today: string): boolean {
  return r.retired_at === null && r.retire_after >= today;
}

/** The ruler id of a holdout run: the active item set and its label commitments, nothing else. */
export function setSha256(active: readonly ManifestRow[]): string {
  const lines = [...active]
    .sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0))
    .map((r) => `${r.item_id}\t${r.claim_sha256}\t${r.label_commit}`);
  return sha256Hex(lines.join('\n'));
}

// ---- checker pair (F2 ledger rule) -----------------------------------------------------------

/** 'provider:model' -> the model family production uses for the two-family rule (free-votes.ts). */
export function familyOfChecker(checker: string): string {
  const i = checker.indexOf(':');
  return modelFamily(i >= 0 ? checker.slice(i + 1) : checker);
}

/** Two or more distinct families, or it is one opinion said more than once: 'incomplete'. */
export function pairStatus(families: readonly string[]): PairStatus {
  return new Set(families.filter((f) => f && f.trim())).size >= 2 ? 'complete' : 'incomplete';
}

/**
 * The record for a two-checker run. Same checker twice, or two models of one family, is
 * 'incomplete' — the rule ledger_pair_daily already applies (src/ledger/daily-totals.ts pairBucket).
 */
export function checkerPair(a: string, b: string, runId: string, measuredAt: string): CheckerPairRecord {
  const families = [familyOfChecker(a), familyOfChecker(b)];
  const status: PairStatus = a !== b && families[0] !== families[1] ? 'complete' : 'incomplete';
  return { families, checkers: [a, b], status, run_id: runId, measured_at: measuredAt };
}

/** The record for a run whose checkers report families directly (the HAL quorum runners). */
export function familiesRecord(families: readonly string[], runId: string, measuredAt: string): CheckerPairRecord {
  const distinct = [...new Set(families.filter((f) => f && f.trim()))].sort();
  return { families: distinct, status: pairStatus(distinct), run_id: runId, measured_at: measuredAt };
}

/**
 * Write each measured item's checker families into the manifest. Families only: no verdict, no
 * label, nothing a reader could score the item with.
 */
export function recordCheckerPairs(
  perItem: ReadonlyMap<string, readonly string[]>,
  runId: string,
  measuredAt: string,
  path: string = MANIFEST_PATH,
): number {
  const rows = readManifest(path);
  let n = 0;
  for (const r of rows) {
    const fams = perItem.get(r.item_id);
    if (!fams) continue;
    r.checker_pair = familiesRecord(fams, runId, measuredAt);
    n += 1;
  }
  writeFileSync(path, serializeManifest(rows));
  return n;
}

// ---- private sources --------------------------------------------------------------------------

export function parsePrivateJsonl(text: string, where: string): PrivateItem[] {
  const out: PrivateItem[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new HoldoutIntegrityError(`${where} line ${i + 1} is not JSON`);
    }
    const id = r['item_id'];
    if (typeof id !== 'string' || !ITEM_ID.test(id)) throw new HoldoutIntegrityError(`${where} line ${i + 1} has no usable item_id`);
    if (typeof r['claim'] !== 'string' || !r['claim'].trim()) throw new HoldoutIntegrityError(`${where} item ${id} has no claim`);
    if (r['label'] !== 'TRUE' && r['label'] !== 'FALSE') throw new HoldoutIntegrityError(`${where} item ${id} label is not TRUE or FALSE`);
    const item: PrivateItem = { item_id: id, claim: r['claim'], label: r['label'] };
    if (Array.isArray(r['edges'])) item.edges = r['edges'] as PrivateItem['edges'];
    out.push(item);
  });
  return out;
}

export type GitRunner = (args: string[], cwd: string) => number | null;

const runGit: GitRunner = (args, cwd) => spawnSync('git', args, { cwd, stdio: 'ignore' }).status;

/**
 * Why a private file path is unsafe, or null when it is fine. Outside the repository is fine.
 * Inside it, the file must be untracked AND gitignored, or one `git add -A` publishes it.
 */
export function privatePathProblem(absPath: string, repoRoot: string = REPO_ROOT, git: GitRunner = runGit): string | null {
  const rel = relative(repoRoot, absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const relPosix = rel.split(sep).join('/');
  const tracked = git(['ls-files', '--error-unmatch', '--', relPosix], repoRoot);
  if (tracked === 0) return `HOLDOUT_FILE (${relPosix}) is committed to git: that text is public now, retire those items`;
  const ignored = git(['check-ignore', '-q', '--', relPosix], repoRoot);
  if (ignored === 0) return null;
  if (ignored === 1) return `HOLDOUT_FILE (${relPosix}) is inside the repository and not gitignored; move it out or name it *.holdout.private.jsonl`;
  return `HOLDOUT_FILE (${relPosix}) is inside the repository and git could not confirm it is ignored`;
}

export type LedgerRead =
  | { kind: 'rows'; rows: Array<{ item_id: string; claim: string; label: string }> }
  | { kind: 'absent'; reason: string };
export type LedgerReader = () => Promise<LedgerRead>;

export function serviceKey(env: NodeJS.ProcessEnv): string {
  return (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
}

/** The checker ledger's holdout rows through the service key, or null when no key is configured. */
export function ledgerReaderFromEnv(env: NodeJS.ProcessEnv): LedgerReader | null {
  const url = (env.SUPABASE_URL ?? '').trim();
  const key = serviceKey(env);
  if (!url || !key) return null;
  return async () => {
    try {
      const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await sb.from('ledger_items').select('source_id, claim, truth').eq('holdout', true);
      if (error) {
        const code = String((error as { code?: string }).code ?? '');
        if (code === '42P01' || code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message)) {
          return { kind: 'absent', reason: `ledger_items does not exist (${LEDGER_MIGRATION} is not applied)` };
        }
        return { kind: 'absent', reason: `ledger_items could not be read (${code || 'no code'}: ${error.message.slice(0, 120)})` };
      }
      const rows = (data ?? []) as Array<{ source_id: unknown; claim: unknown; truth: unknown }>;
      return { kind: 'rows', rows: rows.map((r) => ({ item_id: String(r.source_id), claim: String(r.claim), label: String(r.truth) })) };
    } catch (e) {
      return { kind: 'absent', reason: `ledger_items unreachable (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` };
    }
  };
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
  /** undefined: from env (SUPABASE_URL + a service key). null: no ledger. */
  readLedger?: LedgerReader | null;
  today?: string;
  repoRoot?: string;
  git?: GitRunner;
}

export interface LoadedHoldout {
  source: string;
  items: VerifiedItem[];
  active: ManifestRow[];
  set_sha256: string;
  rotations: string[];
  /** Past retire_after but not yet retired by holdout-rotate.ts: not counted. */
  overdue: number;
  retired: number;
}

async function readPrivate(opts: LoadOptions): Promise<{ source: string; items: PrivateItem[] }> {
  const env = opts.env ?? process.env;
  const file = (env.HOLDOUT_FILE ?? '').trim();
  if (file) {
    const abs = resolve(file);
    if (!existsSync(abs)) throw new HoldoutNotCheckedError('HOLDOUT_FILE is set but no file is at that path', ['HOLDOUT_FILE (no file at the path it names)']);
    const problem = privatePathProblem(abs, opts.repoRoot ?? REPO_ROOT, opts.git ?? runGit);
    if (problem) throw new HoldoutIntegrityError(problem);
    return { source: 'HOLDOUT_FILE', items: parsePrivateJsonl(readFileSync(abs, 'utf8'), 'HOLDOUT_FILE') };
  }
  const reader = opts.readLedger === undefined ? ledgerReaderFromEnv(env) : opts.readLedger;
  if (!reader) {
    throw new HoldoutNotCheckedError('no private holdout source: HOLDOUT_FILE is unset and no service key reaches ledger_items', [
      'HOLDOUT_FILE (unset)',
      'ledger_items (no SUPABASE_URL + service key in this environment)',
    ]);
  }
  const got = await reader();
  if (got.kind === 'absent') throw new HoldoutNotCheckedError(`HOLDOUT_FILE is unset and ${got.reason}`, ['HOLDOUT_FILE (unset)', `ledger_items (${got.reason})`]);
  if (got.rows.length === 0) {
    throw new HoldoutNotCheckedError('HOLDOUT_FILE is unset and ledger_items holds no holdout rows', ['HOLDOUT_FILE (unset)', 'ledger_items (no rows where holdout = true)']);
  }
  const text = got.rows.map((r) => JSON.stringify({ item_id: r.item_id, claim: r.claim, label: r.label })).join('\n');
  return { source: 'ledger_items (holdout = true)', items: parsePrivateJsonl(text, 'ledger_items') };
}

/**
 * Check private items against manifest rows. Throws HoldoutIntegrityError naming item ids (never
 * text) on: an active item missing, a claim hash or label commitment that does not match, an item
 * the manifest does not list, or an id repeated in the private source.
 */
export function verifyAgainstManifest(items: readonly PrivateItem[], rows: readonly ManifestRow[], today: string): VerifiedItem[] {
  const byId = new Map<string, PrivateItem>();
  const dup: string[] = [];
  for (const it of items) {
    if (byId.has(it.item_id)) dup.push(it.item_id);
    byId.set(it.item_id, it);
  }
  if (dup.length) throw new HoldoutIntegrityError(`the private source repeats item ids: ${dup.join(', ')}`);
  const listed = new Set(rows.map((r) => r.item_id));
  const unregistered = items.filter((it) => !listed.has(it.item_id)).map((it) => it.item_id);
  const missing: string[] = [];
  const claimMismatch: string[] = [];
  const labelMismatch: string[] = [];
  const out: VerifiedItem[] = [];
  for (const r of rows) {
    const it = byId.get(r.item_id);
    const active = isActive(r, today);
    if (!it) {
      if (active) missing.push(r.item_id);
      continue;
    }
    if (claimSha256(it.claim) !== r.claim_sha256) claimMismatch.push(r.item_id);
    else if (labelCommit(it.item_id, it.label, it.claim) !== r.label_commit) labelMismatch.push(r.item_id);
    else if (active) out.push({ item_id: it.item_id, claim: it.claim, label: it.label });
  }
  const faults: string[] = [];
  if (missing.length) faults.push(`${missing.length} active manifest item(s) missing from the private source: ${missing.join(', ')}`);
  if (claimMismatch.length) faults.push(`${claimMismatch.length} item(s) whose private text does not hash to the manifest: ${claimMismatch.join(', ')}`);
  if (labelMismatch.length) faults.push(`${labelMismatch.length} item(s) whose private label does not match its commitment: ${labelMismatch.join(', ')}`);
  if (unregistered.length) faults.push(`${unregistered.length} private item(s) the manifest does not list (register with holdout-rotate.ts add): ${unregistered.join(', ')}`);
  if (faults.length) throw new HoldoutIntegrityError(`REFUSING TO MEASURE the private holdout. ${faults.join('; ')}`);
  return out;
}

/**
 * The private holdout, verified against the committed manifest. Throws HoldoutNotCheckedError
 * (exit 2) when there is nothing to measure and HoldoutIntegrityError (exit 1) on any mismatch.
 */
export async function loadPrivateHoldout(opts: LoadOptions = {}): Promise<LoadedHoldout> {
  const today = opts.today ?? utcToday();
  const rows = readManifest(opts.manifestPath ?? MANIFEST_PATH);
  const { source, items } = await readPrivate(opts);
  const verified = verifyAgainstManifest(items, rows, today);
  const active = rows.filter((r) => isActive(r, today));
  const overdue = rows.filter((r) => r.retired_at === null && r.retire_after < today).length;
  const retired = rows.filter((r) => r.retired_at !== null).length;
  if (active.length === 0) {
    throw new HoldoutNotCheckedError(
      `the manifest lists no active item (${rows.length} rows, ${retired} retired, ${overdue} past retire_after); register items with holdout-rotate.ts add`,
      ['eval/holdout/manifest.jsonl (no active item)'],
    );
  }
  return {
    source,
    items: verified,
    active,
    set_sha256: setSha256(active),
    rotations: [...new Set(active.map((r) => r.rotation))].sort(),
    overdue,
    retired,
  };
}

/** The fixed instruction a claim-as-answer runner pairs with each private claim. */
export const VERIFY_PROMPT = 'Is the following claim true? Answer TRUE or FALSE.';

/** The ruler a private holdout number is stated against. */
export function holdoutRuler(h: Pick<LoadedHoldout, 'set_sha256' | 'rotations' | 'active'>): string {
  return `private-holdout@${h.set_sha256.slice(0, 12)} rotation=${h.rotations.join(',')} n=${h.active.length}`;
}

// ---- CLI --------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd !== 'verify') {
    console.error('usage: holdout.ts verify');
    return 1;
  }
  try {
    const h = await loadPrivateHoldout();
    console.log(`VERIFIED: ${h.items.length} active item(s) from ${h.source} match ${holdoutRuler(h)}`);
    console.log(`  retired ${h.retired}, past retire_after ${h.overdue}${h.overdue ? ' (run holdout-rotate.ts retire)' : ''}`);
    return 0;
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    if (e instanceof HoldoutNotCheckedError) console.log(`  missing: ${e.missing.join('; ')}`);
    return exitCodeFor(e);
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
