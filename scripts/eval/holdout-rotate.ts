/**
 * ROTATE THE PRIVATE HOLDOUT (S60, 2026-10-07). Writes eval/holdout/manifest.jsonl only, and only
 * hashes, label commitments and undirected edges: never a claim, never a label.
 *
 *   npx ts-node scripts/eval/holdout-rotate.ts retire [--today YYYY-MM-DD]
 *       Marks every row past its retire_after as retired (retired_at = today). A retired item stops
 *       counting; its row stays, so an old number can still name the set it was taken on.
 *
 *   npx ts-node scripts/eval/holdout-rotate.ts add --rotation <id> --retire-after YYYY-MM-DD
 *        [--from <private.jsonl>] [--today YYYY-MM-DD]
 *       Registers every item in the private file (default: HOLDOUT_FILE) that the manifest does not
 *       list yet. Each private line is { item_id, claim, label, edges? }, where an edge is
 *       { relation, kind?, locator?, url, sha256 }; `relation` (supports / contradicts) is the label
 *       in another form and is dropped before the row is written.
 *
 * REFUSES, before writing anything: a private file inside the repository that git does not ignore;
 * a claim shorter than MIN_CLAIM_CHARS or longer than MAX_CLAIM_CHARS; an item_id or claim already
 * in the manifest; and any claim that already appears in a committed file (holdout-leak-scan.ts).
 * A public sentence cannot become a holdout item; write a new one.
 *
 * Prints counts and item ids. It never prints a claim or a label.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  claimSha256,
  HoldoutIntegrityError,
  labelCommit,
  MANIFEST_PATH,
  MAX_CLAIM_CHARS,
  MIN_CLAIM_CHARS,
  normalizeClaim,
  parsePrivateJsonl,
  privatePathProblem,
  readManifest,
  REPO_ROOT,
  serializeManifest,
  utcToday,
  type Edge,
  type ManifestRow,
  type PrivateItem,
} from './holdout';
import { scanRepo } from './holdout-leak-scan';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Rows past retire_after get retired_at = today. Returns the new rows and the ids retired. */
export function retireDue(rows: readonly ManifestRow[], today: string): { rows: ManifestRow[]; retired: string[] } {
  const retired: string[] = [];
  const out = rows.map((r) => {
    if (r.retired_at === null && r.retire_after < today) {
      retired.push(r.item_id);
      return { ...r, retired_at: today };
    }
    return { ...r };
  });
  return { rows: out, retired };
}

/** The committed form of a private edge: answer-key record fields, no direction. */
export function publicEdge(e: Edge & { relation?: string }): Edge {
  const out: Edge = { url: e.url, sha256: e.sha256 };
  if (typeof e.kind === 'string') out.kind = e.kind;
  if (typeof e.locator === 'string') out.locator = e.locator;
  return out;
}

export interface RegisterOptions {
  rotation: string;
  retireAfter: string;
  today: string;
  /** Claim hashes already present in committed files. */
  publicHashes: ReadonlySet<string>;
}

/**
 * Append manifest rows for private items the manifest does not list. Throws, writing nothing, on any
 * refused item; the message names item ids only.
 */
export function registerNew(
  rows: readonly ManifestRow[],
  items: readonly PrivateItem[],
  opts: RegisterOptions,
): { rows: ManifestRow[]; added: string[] } {
  if (!opts.rotation.trim() || opts.rotation.length > 64) throw new HoldoutIntegrityError('--rotation must be a short id');
  if (!DAY.test(opts.retireAfter)) throw new HoldoutIntegrityError('--retire-after must be YYYY-MM-DD');
  if (opts.retireAfter <= opts.today) throw new HoldoutIntegrityError('--retire-after must be after today');
  const listedIds = new Set(rows.map((r) => r.item_id));
  const listedHashes = new Set(rows.map((r) => r.claim_sha256));
  const fresh = items.filter((it) => !listedIds.has(it.item_id));
  const faults: string[] = [];
  const seen = new Set<string>();
  const added: ManifestRow[] = [];
  for (const it of fresh) {
    const n = normalizeClaim(it.claim);
    const h = claimSha256(it.claim);
    if (n.length < MIN_CLAIM_CHARS || n.length > MAX_CLAIM_CHARS) faults.push(`${it.item_id}: claim length outside ${MIN_CLAIM_CHARS}-${MAX_CLAIM_CHARS}`);
    else if (listedHashes.has(h) || seen.has(h)) faults.push(`${it.item_id}: the same claim is already registered`);
    else if (opts.publicHashes.has(h)) faults.push(`${it.item_id}: the claim already appears in a committed file (public; write a new one)`);
    for (const e of it.edges ?? []) {
      if (typeof e?.url !== 'string' || !/^https?:\/\/\S+$/.test(e.url) || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
        faults.push(`${it.item_id}: an edge needs an absolute url and a sha256 hex`);
        break;
      }
    }
    seen.add(h);
    added.push({
      item_id: it.item_id,
      claim_sha256: h,
      label_commit: labelCommit(it.item_id, it.label, it.claim),
      edges: (it.edges ?? []).map(publicEdge),
      checker_pair: null,
      rotation: opts.rotation,
      retire_after: opts.retireAfter,
      retired_at: null,
    });
  }
  if (faults.length) throw new HoldoutIntegrityError(`refused, nothing written: ${faults.join('; ')}`);
  return { rows: [...rows.map((r) => ({ ...r })), ...added], added: added.map((r) => r.item_id) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
  const cmd = process.argv[2];
  const today = arg('today') ?? utcToday();
  if (!DAY.test(today)) {
    console.error('--today must be YYYY-MM-DD');
    return 1;
  }
  const rows = readManifest(MANIFEST_PATH);
  if (cmd === 'retire') {
    const r = retireDue(rows, today);
    writeFileSync(MANIFEST_PATH, serializeManifest(r.rows));
    console.log(`retired ${r.retired.length} item(s)${r.retired.length ? `: ${r.retired.join(', ')}` : ''}`);
    return 0;
  }
  if (cmd === 'add') {
    const from = (arg('from') ?? process.env.HOLDOUT_FILE ?? '').trim();
    if (!from) {
      console.log('NOT_CHECKED: no private file (pass --from or set HOLDOUT_FILE)');
      return 2;
    }
    const abs = resolve(from);
    if (!existsSync(abs)) {
      console.log('NOT_CHECKED: no file at the private path given');
      return 2;
    }
    const problem = privatePathProblem(abs, REPO_ROOT);
    if (problem) throw new HoldoutIntegrityError(problem);
    const items = parsePrivateJsonl(readFileSync(abs, 'utf8'), 'private file');
    const listed = new Set(rows.map((r) => r.item_id));
    const fresh = items.filter((it) => !listed.has(it.item_id));
    const scan = scanRepo(REPO_ROOT, new Set(fresh.map((it) => claimSha256(it.claim))));
    const r = registerNew(rows, items, {
      rotation: arg('rotation') ?? '',
      retireAfter: arg('retire-after') ?? '',
      today,
      publicHashes: new Set(scan.hits.keys()),
    });
    writeFileSync(MANIFEST_PATH, serializeManifest(r.rows));
    console.log(`registered ${r.added.length} item(s) (scanned ${scan.files} files, ${scan.candidates} candidate sentences)`);
    if (r.added.length) console.log(`  ${r.added.join(', ')}`);
    return 0;
  }
  console.error('usage: holdout-rotate.ts retire [--today D] | add --rotation <id> --retire-after D [--from <private.jsonl>] [--today D]');
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
