/**
 * The private rotating holdout (Sean, BUS S60, 2026-10-07): scripts/eval/holdout.ts, the rotation
 * script, and the offline runner's holdout path.
 *
 * EVERY SENTENCE HERE IS SYNTHETIC: generated per run, with a random salt, in a temp directory
 * outside the repository. None is a real holdout item and none is committed. The committed
 * manifest (eval/holdout/manifest.jsonl) is never written by this file.
 *
 * What this defends:
 *   - git gets hashes, label commitments and undirected edges, never a claim or a label;
 *   - no private source is NOT_CHECKED (exit 2), never a pass and never a public fallback;
 *   - private text that does not match the manifest fails loudly, naming ids, never text;
 *   - one checker family is 'incomplete', matching the ledger's F2 rule;
 *   - rotation retires past-date items and refuses a sentence already public.
 */
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ??= 'dummy';

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oneFamily, type Voter } from '../src/classify/free-votes';
import {
  checkerPair,
  claimSha256,
  exitCodeFor,
  familiesRecord,
  HoldoutIntegrityError,
  HoldoutNotCheckedError,
  labelCommit,
  loadPrivateHoldout,
  normalizeClaim,
  pairStatus,
  parseManifest,
  privatePathProblem,
  readManifest,
  recordCheckerPairs,
  REPO_ROOT,
  serializeManifest,
  sha256Hex,
  type LedgerReader,
  type PrivateItem,
} from '../scripts/eval/holdout';
import { registerNew, retireDue } from '../scripts/eval/holdout-rotate';
import { diskForm, formatHeadline, runOfflineEval } from '../scripts/hal-eval/run-frozen-corpus-offline';

const TODAY = '2026-10-07';
const LATER = '2027-01-07';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'holdout-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function synthetic(n: number): PrivateItem[] {
  const salt = randomBytes(6).toString('hex');
  return Array.from({ length: n }, (_, i) => ({
    item_id: `syn-${i}`,
    claim: `Synthetic test claim ${salt} number ${i} says the test sky is ${i % 2 ? 'green' : 'blue'}.`,
    label: i % 2 ? ('FALSE' as const) : ('TRUE' as const),
    edges: [{ relation: i % 2 ? 'contradicts' : 'supports', kind: 'test', url: `https://example.org/record/${i}`, sha256: sha256Hex(`record ${i}`) }],
  }));
}

let seq = 0;
/** A temp manifest + HOLDOUT_FILE pair built through the real rotation code. */
function setup(items: PrivateItem[], privateItems: PrivateItem[] = items) {
  seq += 1;
  const { rows } = registerNew([], items, { rotation: 'r-test', retireAfter: LATER, today: TODAY, publicHashes: new Set() });
  const manifestPath = join(dir, `manifest-${seq}.jsonl`);
  const holdoutFile = join(dir, `items-${seq}.holdout.private.jsonl`);
  writeFileSync(manifestPath, serializeManifest(rows));
  writeFileSync(holdoutFile, privateItems.map((it) => JSON.stringify(it)).join('\n') + '\n');
  return { manifestPath, holdoutFile, rows };
}

describe('hashing', () => {
  it('normalizes case, whitespace, curly quotes and edge punctuation to one hash', () => {
    const a = 'The test sky is “blue”.';
    const b = '  **the   TEST sky is "blue"**  ';
    expect(normalizeClaim(a)).toBe(normalizeClaim(b));
    expect(claimSha256(a)).toBe(claimSha256(b));
    expect(claimSha256(a)).not.toBe(claimSha256('The test sky is green.'));
  });

  it('commits to a label without exposing it: the commitment differs by label and by item', () => {
    const c = 'A synthetic sentence about nothing in particular.';
    expect(labelCommit('x', 'TRUE', c)).not.toBe(labelCommit('x', 'FALSE', c));
    expect(labelCommit('x', 'TRUE', c)).not.toBe(labelCommit('y', 'TRUE', c));
    expect(labelCommit('x', 'TRUE', c)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the committed manifest holds no text and no label', () => {
  it('a registered row carries only hashes, a commitment and undirected edges', () => {
    const items = synthetic(4);
    const { rows } = setup(items);
    const text = serializeManifest(rows);
    for (const it of items) expect(text).not.toContain(it.claim);
    expect(text).not.toMatch(/"label"|"claim"|"relation"|supports|contradicts|"TRUE"|"FALSE"/);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['checker_pair', 'claim_sha256', 'edges', 'item_id', 'label_commit', 'retire_after', 'retired_at', 'rotation']);
      for (const e of r.edges) expect(Object.keys(e).sort()).toEqual(['kind', 'sha256', 'url']);
    }
    expect(parseManifest(text)).toHaveLength(4);
  });

  it('refuses a row that carries a claim, a label, or a directed edge', () => {
    const [row] = setup(synthetic(1)).rows;
    const bad = (o: object) => () => parseManifest(JSON.stringify(o));
    expect(bad({ ...row, claim: 'a sentence that must never be committed' })).toThrow(/outside the manifest schema/);
    expect(bad({ ...row, label: 'TRUE' })).toThrow(/outside the manifest schema/);
    expect(bad({ ...row, edges: [{ relation: 'supports', url: 'https://example.org/x', sha256: sha256Hex('x') }] })).toThrow(/direction is the label/);
  });

  it('the committed manifest parses', () => {
    expect(Array.isArray(readManifest())).toBe(true);
  });
});

describe('loading the private holdout', () => {
  it('HOLDOUT_FILE that matches the manifest loads, verified, with a ruler', async () => {
    const items = synthetic(6);
    const { manifestPath, holdoutFile } = setup(items);
    const h = await loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null });
    expect(h.source).toBe('HOLDOUT_FILE');
    expect(h.items.map((i) => i.item_id).sort()).toEqual(items.map((i) => i.item_id).sort());
    expect(h.set_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h.rotations).toEqual(['r-test']);
  });

  it('the ledger is the second source, and its rows are verified the same way', async () => {
    const items = synthetic(3);
    const { manifestPath } = setup(items);
    const readLedger: LedgerReader = async () => ({ kind: 'rows', rows: items.map((i) => ({ item_id: i.item_id, claim: i.claim, label: i.label })) });
    const h = await loadPrivateHoldout({ env: {}, manifestPath, today: TODAY, readLedger });
    expect(h.source).toMatch(/^ledger_items/);
    expect(h.items).toHaveLength(3);
  });
});

describe('(b) no private source is NOT_CHECKED, exit 2 — never a pass, never a public fallback', () => {
  it('neither HOLDOUT_FILE nor a service key: NOT_CHECKED naming both sources', async () => {
    const { manifestPath } = setup(synthetic(2));
    const p = loadPrivateHoldout({ env: {}, manifestPath, today: TODAY });
    await expect(p).rejects.toBeInstanceOf(HoldoutNotCheckedError);
    const err = (await p.catch((e) => e)) as HoldoutNotCheckedError;
    expect(err.missing.join(' ')).toMatch(/HOLDOUT_FILE/);
    expect(err.missing.join(' ')).toMatch(/ledger_items/);
    expect(exitCodeFor(err)).toBe(2);
  });

  it('HOLDOUT_FILE named but absent: NOT_CHECKED, no fall-through to the ledger', async () => {
    const { manifestPath } = setup(synthetic(2));
    let ledgerAsked = false;
    const readLedger: LedgerReader = async () => {
      ledgerAsked = true;
      return { kind: 'rows', rows: [] };
    };
    await expect(loadPrivateHoldout({ env: { HOLDOUT_FILE: join(dir, 'nope.holdout.private.jsonl') }, manifestPath, today: TODAY, readLedger })).rejects.toBeInstanceOf(
      HoldoutNotCheckedError,
    );
    expect(ledgerAsked).toBe(false);
  });

  it('the ledger table missing (migration not applied) is NOT_CHECKED and says so', async () => {
    const { manifestPath } = setup(synthetic(2));
    const readLedger: LedgerReader = async () => ({ kind: 'absent', reason: 'ledger_items does not exist (supabase/migrations/20261006150000_checker_ledger.sql is not applied)' });
    await expect(loadPrivateHoldout({ env: {}, manifestPath, today: TODAY, readLedger })).rejects.toThrow(/NOT_CHECKED: .*20261006150000_checker_ledger\.sql is not applied/);
  });

  it('the ledger reachable but holding no holdout rows is NOT_CHECKED', async () => {
    const { manifestPath } = setup(synthetic(2));
    await expect(loadPrivateHoldout({ env: {}, manifestPath, today: TODAY, readLedger: async () => ({ kind: 'rows', rows: [] }) })).rejects.toThrow(
      /no holdout rows/,
    );
  });

  it('the offline runner rejects with NOT_CHECKED instead of measuring a public set', async () => {
    const { manifestPath } = setup(synthetic(2));
    await expect(runOfflineEval({ split: 'holdout', write: false, holdout: { env: {}, manifestPath, today: TODAY } })).rejects.toBeInstanceOf(HoldoutNotCheckedError);
  });

  it('the CLI exits 2 with NOT_CHECKED when no source is configured', () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: '' };
    const r = spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'scripts/eval/holdout.ts', 'verify'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.stdout).toMatch(/NOT_CHECKED/);
    expect(r.status).toBe(2);
  }, 130_000);
});

describe('(c) private text that does not match the manifest fails loudly', () => {
  it('an edited claim fails, naming the item id and never the text', async () => {
    const items = synthetic(4);
    const edited = items.map((it, i) => (i === 2 ? { ...it, claim: `${it.claim} Edited.` } : it));
    const { manifestPath, holdoutFile } = setup(items, edited);
    const err = (await loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(HoldoutIntegrityError);
    expect(err.message).toMatch(/does not hash to the manifest: syn-2/);
    for (const it of edited) expect(err.message).not.toContain(it.claim);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('a relabelled item fails on its label commitment', async () => {
    const items = synthetic(4);
    const flipped = items.map((it, i) => (i === 1 ? { ...it, label: it.label === 'TRUE' ? ('FALSE' as const) : ('TRUE' as const) } : it));
    const { manifestPath, holdoutFile } = setup(items, flipped);
    await expect(loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null })).rejects.toThrow(
      /label does not match its commitment: syn-1/,
    );
  });

  it('an active item missing from the private source fails', async () => {
    const items = synthetic(4);
    const { manifestPath, holdoutFile } = setup(items, items.slice(1));
    await expect(loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null })).rejects.toThrow(
      /missing from the private source: syn-0/,
    );
  });

  it('a private item the manifest does not list fails', async () => {
    const items = synthetic(3);
    const extra = { ...synthetic(1)[0]!, item_id: 'syn-extra' };
    const { manifestPath, holdoutFile } = setup(items, [...items, extra]);
    await expect(loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null })).rejects.toThrow(
      /does not list .*syn-extra/,
    );
  });
});

describe('(d) checker pair: one family is incomplete (the ledger F2 rule)', () => {
  it('two models of one family are incomplete; two families are complete', () => {
    const same = checkerPair('groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b', 'r', TODAY);
    expect(same.families).toEqual(['gpt-oss', 'gpt-oss']);
    expect(same.status).toBe('incomplete');
    expect(checkerPair('groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-120b', 'r', TODAY).status).toBe('incomplete');
    const two = checkerPair('groq:openai/gpt-oss-120b', 'cerebras:qwen-3.8-27b', 'r', TODAY);
    expect(two.families).toEqual(['gpt-oss', 'qwen']);
    expect(two.status).toBe('complete');
  });

  it('agrees with the stamp rule production uses (free-votes oneFamily)', () => {
    const pairs: Array<[Voter, Voter]> = [
      [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'groq', model: 'openai/gpt-oss-20b' }],
      [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'cerebras', model: 'qwen-3.8-27b' }],
      [{ provider: 'cerebras', model: 'qwen-3.8-27b' }, { provider: 'openrouter', model: 'qwen/qwen3-next-80b' }],
    ];
    for (const [a, b] of pairs) {
      const rec = checkerPair(`${a.provider}:${a.model}`, `${b.provider}:${b.model}`, 'r', TODAY);
      expect(rec.status === 'incomplete').toBe(oneFamily(a, b));
    }
  });

  it('a runner reporting families: fewer than two distinct is incomplete', () => {
    expect(pairStatus(['llama', 'llama'])).toBe('incomplete');
    expect(pairStatus(['llama', ' '])).toBe('incomplete');
    expect(pairStatus(['llama', 'qwen'])).toBe('complete');
    expect(familiesRecord([], 'r', TODAY).status).toBe('incomplete');
    expect(familiesRecord(['llama', 'llama'], 'r', TODAY).status).toBe('incomplete');
    expect(familiesRecord(['llama', 'qwen', 'llama'], 'r', TODAY)).toMatchObject({ families: ['llama', 'qwen'], status: 'complete' });
  });

  it('recording the pair writes families into the manifest and nothing that scores the item', () => {
    const items = synthetic(3);
    const { manifestPath } = setup(items);
    const n = recordCheckerPairs(new Map([['syn-0', ['llama', 'qwen']], ['syn-1', ['llama']]]), 'run-x', `${TODAY}T00:00:00Z`, manifestPath);
    expect(n).toBe(2);
    const rows = readManifest(manifestPath);
    expect(rows.find((r) => r.item_id === 'syn-0')!.checker_pair).toMatchObject({ families: ['llama', 'qwen'], status: 'complete', run_id: 'run-x' });
    expect(rows.find((r) => r.item_id === 'syn-1')!.checker_pair!.status).toBe('incomplete');
    expect(rows.find((r) => r.item_id === 'syn-2')!.checker_pair).toBeNull();
    expect(readFileSync(manifestPath, 'utf8')).not.toMatch(/verdict|"TRUE"|"FALSE"/);
  });

  it('the offline runner, with no checker family, scores the private holdout as incomplete and writes no item ids', async () => {
    const items = synthetic(4);
    const { manifestPath, holdoutFile } = setup(items);
    const res = await runOfflineEval({ split: 'holdout', write: false, holdout: { env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null } });
    expect(res.holdout).toBe('private');
    expect(res.rows).toBe(4);
    expect(res.ruler).toMatch(/^private-holdout@[0-9a-f]{12} rotation=r-test n=4 /);
    expect(res.checker_pair.status).toBe('incomplete');
    const headline = formatHeadline(res).join('\n');
    expect(headline).toContain('PRIVATE HOLDOUT');
    expect(headline).not.toContain('RETIRED PUBLIC SET');
    const disk = JSON.stringify(diskForm(res));
    for (const it of items) {
      expect(disk).not.toContain(it.item_id);
      expect(disk).not.toContain(it.claim);
    }
  }, 60_000);
});

describe('rotation', () => {
  it('retires items past retire_after; the loader then stops counting them', async () => {
    const items = synthetic(3);
    const { manifestPath, holdoutFile, rows } = setup(items);
    rows[0]!.retire_after = '2026-10-01';
    const r = retireDue(rows, TODAY);
    expect(r.retired).toEqual(['syn-0']);
    expect(r.rows[0]!.retired_at).toBe(TODAY);
    writeFileSync(manifestPath, serializeManifest(r.rows));
    const h = await loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: TODAY, readLedger: null });
    expect(h.items.map((i) => i.item_id).sort()).toEqual(['syn-1', 'syn-2']);
    expect(h.retired).toBe(1);
  });

  it('every item retired is NOT_CHECKED, not a measurement of nothing', async () => {
    const items = synthetic(2);
    const { manifestPath, holdoutFile, rows } = setup(items);
    writeFileSync(manifestPath, serializeManifest(retireDue(rows, '2027-02-01').rows));
    await expect(loadPrivateHoldout({ env: { HOLDOUT_FILE: holdoutFile }, manifestPath, today: '2027-02-01', readLedger: null })).rejects.toThrow(
      /no active item/,
    );
  });

  it('refuses a sentence already in a committed file, a repeat, a short claim, or a past date — writing nothing', () => {
    const items = synthetic(2);
    const opts = { rotation: 'r2', retireAfter: LATER, today: TODAY, publicHashes: new Set<string>() };
    expect(() => registerNew([], items, { ...opts, publicHashes: new Set([claimSha256(items[0]!.claim)]) })).toThrow(/already appears in a committed file/);
    const { rows } = registerNew([], items, opts);
    expect(() => registerNew(rows, [{ ...items[0]!, item_id: 'syn-again' }], opts)).toThrow(/already registered/);
    expect(() => registerNew([], [{ item_id: 'short', claim: 'Too short', label: 'TRUE' }], opts)).toThrow(/claim length/);
    expect(() => registerNew([], items, { ...opts, retireAfter: TODAY })).toThrow(/after today/);
    // Already-registered ids are skipped, not re-added.
    expect(registerNew(rows, items, opts).added).toEqual([]);
  });
});

describe('the private file path guard', () => {
  it('outside the repository is fine; inside it must be untracked and gitignored', () => {
    const inRepo = join(REPO_ROOT, 'eval', 'holdout', 'x.jsonl');
    expect(privatePathProblem(join(dir, 'x.jsonl'))).toBeNull();
    expect(privatePathProblem(inRepo, REPO_ROOT, (args) => (args[0] === 'ls-files' ? 1 : 0))).toBeNull();
    expect(privatePathProblem(inRepo, REPO_ROOT, (args) => (args[0] === 'ls-files' ? 0 : 0))).toMatch(/committed to git/);
    expect(privatePathProblem(inRepo, REPO_ROOT, (args) => (args[0] === 'ls-files' ? 1 : 1))).toMatch(/not gitignored/);
  });

  it('the real .gitignore covers the documented private names (git check-ignore)', () => {
    expect(privatePathProblem(join(REPO_ROOT, 'eval', 'holdout', 'private', 'items.jsonl'))).toBeNull();
    expect(privatePathProblem(join(REPO_ROOT, 'anything.holdout.private.jsonl'))).toBeNull();
    expect(privatePathProblem(join(REPO_ROOT, 'eval', 'holdout', 'items.jsonl'))).toMatch(/not gitignored/);
  });
});
