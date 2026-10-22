/**
 * Anti-farming eligibility — SHADOW. Four properties:
 *   1. Every threat and honest fixture gets the tier, independence, dimension statuses and reasons
 *      it is pinned to (tests/fixtures/antifarming-cases.ts), and the table is printed.
 *   2. Invariants over all of them: threats earn 0 credibility units; honest cases are never
 *      AFFILIATED; UNKNOWN never credits; units are never negative; 2FA changes nothing but its
 *      own reason.
 *   3. The OwnerLink inputs are exactly what the real `ownerRelation` returns on real claim shapes.
 *   4. ISOLATION, the load-bearing one: nothing live can reach the module. Entrypoints are
 *      DISCOVERED from the deploy configs (railway*.json, Dockerfile*, package.json), not listed,
 *      and the same walker is shown to reach repid-update.ts, so a walker that matches nothing
 *      cannot pass. A whole-tree reference scan backs it, with its own positive control.
 */
jest.mock('../src/db', () => ({ db: {} })); // ownerRelation's module imports db at load; it is never called here.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

import {
  EVIDENCE_TIERS,
  REASONS,
  evaluateEligibility,
  evaluateEligibilityBatch,
  renderEligibilityTable,
  type EligibilityEvent,
  type EligibilityRecord,
} from '../src/shadow/antifarming-eligibility';
import { CASES, DISTINCT_ADMIN, DISTINCT_STRONG, SAME_ADMIN, SAME_STRONG, UNKNOWN } from './fixtures/antifarming-cases';
import { ownerRelation } from '../src/services/owner-distinct-shadow';
import type { OwnerClaim, OwnerResolution } from '../src/services/agent-owner-resolver';

const ROOT = resolve(__dirname, '..');
const MODULE = join(ROOT, 'src', 'shadow', 'antifarming-eligibility.ts');

const subjectRecord = (c: (typeof CASES)[number]): EligibilityRecord => {
  const records = evaluateEligibilityBatch(c.events);
  const i = c.events.findIndex((e) => e.event_id === c.subject);
  if (i < 0) throw new Error(`fixture ${c.name}: subject ${c.subject} not in its events`);
  return records[i] as EligibilityRecord;
};

describe('anti-farming eligibility: fixtures', () => {
  test.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = subjectRecord(c);
    expect({
      tier: r.tier,
      independence: r.independence,
      operational: r.operational_reliability.status,
      credibility: r.independent_credibility.status,
      credibility_decided_by: r.independent_credibility.decided_by,
    }).toEqual({
      tier: c.expect.tier,
      independence: c.expect.independence,
      operational: c.expect.operational,
      credibility: c.expect.credibility,
      credibility_decided_by: c.expect.credibility_decided_by,
    });
    for (const reason of c.expect.reasons_include) expect(r.reasons).toContain(reason);
  });

  test('prints the table', () => {
    const table = renderEligibilityTable(CASES.map((c) => ({ name: `${c.kind}: ${c.name}`, record: subjectRecord(c) })));
    // eslint-disable-next-line no-console
    console.log(`\nANTI-FARMING ELIGIBILITY (shadow)\n${table}\n`);
    expect(table.split('\n')).toHaveLength(CASES.length + 2);
  });

  test('covers every threat the brief names, and the three honest cases', () => {
    const names = CASES.map((c) => c.name);
    for (const n of ['same_owner_wash_trade', 'two_wallet_sybil', 'circular_fund_recycling', 'paid_validator_ring',
      'self_created_bug_and_fix', 'evidence_laundering', 'confidence_laundering', 'parent_child_lineage',
      'loyal_repeat_customer', 'small_unknown_new_owner', 'unrelated_counterparty_independent_acceptance']) {
      expect(names).toContain(n);
    }
  });
});

describe('anti-farming eligibility: invariants over every fixture', () => {
  const all = CASES.map((c) => ({ c, r: subjectRecord(c) }));

  test('no threat earns an independent-credibility unit', () => {
    for (const { c, r } of all.filter((x) => x.c.kind === 'threat')) {
      expect([c.name, r.independent_credibility.units]).toEqual([c.name, 0]);
    }
  });

  test('no honest case is AFFILIATED, ZERO on either dimension, or uncredited for operational work it delivered', () => {
    for (const { c, r } of all.filter((x) => x.c.kind === 'honest')) {
      expect([c.name, r.independence]).not.toEqual([c.name, 'AFFILIATED']);
      expect([c.name, r.operational_reliability.status]).toEqual([c.name, 'COUNTS']);
      expect([c.name, r.independent_credibility.status]).not.toEqual([c.name, 'ZERO']);
    }
  });

  test('UNKNOWN is kept apart from VERIFIED: an UNKNOWN never credits, a VERIFIED always has its evidence named', () => {
    for (const { c, r } of all) {
      if (r.independence === 'UNKNOWN') expect([c.name, r.independent_credibility.status]).not.toEqual([c.name, 'COUNTS']);
      if (r.independence === 'VERIFIED_INDEPENDENT') {
        const named = r.reasons.some((x) => ['OWNER_DISTINCT_STRONG', 'OUTCOME_CONFIRMED_INDEPENDENT', 'OUTCOME_CONFIRMED_FAIL', 'REPRODUCED_BY_INDEPENDENT_OWNERS'].includes(x));
        expect([c.name, named]).toEqual([c.name, true]);
      }
    }
  });

  test('units are 0 or 1, 1 exactly when COUNTS; never negative', () => {
    for (const { r } of all) {
      for (const d of [r.operational_reliability, r.independent_credibility]) {
        expect([0, 1]).toContain(d.units);
        expect(d.units === 1).toBe(d.status === 'COUNTS');
      }
    }
  });

  test('the record is shadow, says it writes no RepID, carries no delta, and is frozen', () => {
    for (const { r } of all) {
      expect(r.shadow).toBe(true);
      expect(r.writes_repid).toBe(false);
      expect(Object.keys(r).filter((k) => /delta|score|repid/i.test(k))).toEqual(['writes_repid']);
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.independent_credibility)).toBe(true);
      expect(EVIDENCE_TIERS).toContain(r.tier);
      for (const reason of r.reasons) expect(REASONS).toHaveProperty(reason);
    }
  });

  test('2FA is account control, never ownership: toggling it changes nothing but its own reason', () => {
    const strip = (r: EligibilityRecord) => ({ ...r, reasons: r.reasons.filter((x) => x !== 'TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP') });
    for (const c of CASES) {
      const off = evaluateEligibilityBatch(c.events.map((e) => ({ ...e, account_control: undefined })));
      const on = evaluateEligibilityBatch(c.events.map((e) => ({ ...e, account_control: { actor_two_factor: true, counterparty_two_factor: true } })));
      expect(on.map(strip)).toEqual(off.map(strip));
      for (const r of on) expect(r.reasons).toContain('TWO_FACTOR_IS_ACCOUNT_CONTROL_NOT_OWNERSHIP');
    }
  });
});

describe('anti-farming eligibility: edges', () => {
  const base: EligibilityEvent = {
    event_id: 'e', kind: 'trade', actor_id: 'a', counterparty_id: 'b', counterparty_owner: DISTINCT_STRONG,
    receipt: { receipt_id: 'r', server_settled: true, bound_event_id: 'e' }, counterparty_reported_outcome: 'accepted',
  };

  test('the event a receipt is bound to keeps it while the laundered citations lose it', () => {
    const laundering = CASES.find((c) => c.name === 'evidence_laundering')!;
    const [bound, ...rest] = evaluateEligibilityBatch(laundering.events);
    expect(bound!.tier).toBe('OWNER_DISTINCT_OBSERVED');
    expect(bound!.independent_credibility.status).toBe('COUNTS');
    for (const r of rest) expect(r.independent_credibility.decided_by).toBe('RECEIPT_BOUND_TO_OTHER_EVENT');
  });

  test('an unbound receipt cited once is admissible and says it is unbound', () => {
    const r = evaluateEligibility({ ...base, receipt: { receipt_id: 'r', server_settled: true, bound_event_id: null } });
    expect(r.tier).toBe('OWNER_DISTINCT_OBSERVED');
    expect(r.reasons).toContain('RECEIPT_UNBOUND');
  });

  test('a caller-asserted receipt is not evidence', () => {
    const r = evaluateEligibility({ ...base, receipt: { receipt_id: 'r', server_settled: false, bound_event_id: 'e' } });
    expect(r.tier).toBe('SELF_ATTESTED');
    expect(r.operational_reliability).toMatchObject({ status: 'UNKNOWN', decided_by: 'RECEIPT_NOT_SERVER_SETTLED' });
  });

  test('no receipt and no counterparty is self-attested and UNKNOWN, not ZERO', () => {
    const r = evaluateEligibility({ ...base, receipt: null, counterparty_id: null, counterparty_owner: null, counterparty_reported_outcome: null });
    expect(r.tier).toBe('SELF_ATTESTED');
    expect(r.operational_reliability.status).toBe('UNKNOWN');
    expect(r.independent_credibility).toMatchObject({ status: 'UNKNOWN', decided_by: 'NO_RECEIPT_SELF_ATTESTED' });
  });

  test('administrative-only distinctness is UNKNOWN, never VERIFIED', () => {
    const r = evaluateEligibility({ ...base, counterparty_owner: DISTINCT_ADMIN });
    expect(r.tier).toBe('COUNTERPARTY_REPORTED');
    expect(r.independence).toBe('UNKNOWN');
    expect(r.independent_credibility).toMatchObject({ status: 'UNKNOWN', decided_by: 'OWNER_DISTINCT_ADMINISTRATIVE_ONLY' });
  });

  test('same owner on administrative evidence still adds zero credibility, and operational still counts', () => {
    const r = evaluateEligibility({ ...base, counterparty_owner: SAME_ADMIN });
    expect(r.independent_credibility).toMatchObject({ status: 'ZERO', decided_by: 'OWNER_SAME_ADMINISTRATIVE' });
    expect(r.operational_reliability.status).toBe('COUNTS');
  });

  test('a confirmer whose independence is not established is not used', () => {
    const r = evaluateEligibility({ ...base, counterparty_owner: UNKNOWN, confirmation: { by: 'adjudicator', confirmer_owner: DISTINCT_ADMIN, verdict: 'pass' } });
    expect(r.reasons).toContain('CONFIRMER_INDEPENDENCE_UNKNOWN');
    expect(r.reasons).not.toContain('OUTCOME_CONFIRMED_INDEPENDENT');
    expect(r.tier).toBe('COUNTERPARTY_REPORTED');
  });

  test('a same-owner confirmer is affiliation', () => {
    const r = evaluateEligibility({ ...base, confirmation: { by: 'adjudicator', confirmer_owner: SAME_STRONG, verdict: 'pass' } });
    expect(r.independent_credibility).toMatchObject({ status: 'ZERO', decided_by: 'CONFIRMER_SAME_OWNER' });
  });

  test('an engine-run holdout confirms an unknown-owner newcomer: credited, with no owner claim made', () => {
    const r = evaluateEligibility({ ...base, counterparty_owner: UNKNOWN, confirmation: { by: 'holdout', verdict: 'pass' } });
    expect(r.tier).toBe('INDEPENDENT_OUTCOME_CONFIRMED');
    expect(r.independent_credibility.status).toBe('COUNTS');
    expect(r.reasons).toContain('OWNER_UNKNOWN');
  });

  test('a failed independent confirmation earns zero on both, and no negative', () => {
    const r = evaluateEligibility({ ...base, confirmation: { by: 'known_answer', verdict: 'fail' } });
    expect(r.operational_reliability).toMatchObject({ status: 'ZERO', units: 0, decided_by: 'OUTCOME_CONFIRMED_FAIL' });
    expect(r.independent_credibility).toMatchObject({ status: 'ZERO', units: 0 });
  });

  test('two reproducers under one owner are one reproduction', () => {
    const r = evaluateEligibility({
      event_id: 'imp', kind: 'improvement', actor_id: 'a', counterparty_id: null, counterparty_owner: null, receipt: null,
      reproductions: [
        { by_id: 'r1', reproducer_owner: DISTINCT_STRONG, reproducer_owner_key: 'OWNER-X', reproduced: true },
        { by_id: 'r2', reproducer_owner: DISTINCT_STRONG, reproducer_owner_key: 'owner-x', reproduced: true },
      ],
    });
    expect(r.tier).toBe('SELF_ATTESTED');
    expect(r.independent_credibility).toMatchObject({ status: 'UNKNOWN', decided_by: 'REPRODUCTION_INSUFFICIENT' });
  });

  test('a fix for a bug a distinct owner introduced is not a self-created bug', () => {
    const r = evaluateEligibility({ ...base, kind: 'bug_fix', bug_origin: { introduced_by: DISTINCT_STRONG } });
    expect(r.reasons).not.toContain('SELF_CREATED_BUG');
    expect(r.independent_credibility.status).toBe('COUNTS');
  });
});

describe('anti-farming eligibility: OwnerLink is what ownerRelation returns', () => {
  const claim = (ownerKeyKind: OwnerClaim['ownerKeyKind'], ownerKey: string, assurance: OwnerClaim['assurance']): OwnerClaim =>
    ({ source: 'human_agent_bindings', assurance, ownerKey, ownerKeyKind, capUsdcPerTx: null, capUsdcTotal: null });
  const res = (agentId: string, ...claims: OwnerClaim[]): OwnerResolution =>
    ({ status: claims.length ? 'resolved' : 'unknown', agentId, owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] });
  const B1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B2 = 'bbbbbbbb-0000-4000-8000-000000000002';

  test.each([
    ['signed, same builder', res('a', claim('builder_id', B1, 'proven_wallet')), res('b', claim('builder_id', B1, 'attested_unverified')), SAME_STRONG],
    ['unsigned, same builder', res('a', claim('builder_id', B1, 'administrative')), res('b', claim('builder_id', B1, 'administrative')), SAME_ADMIN],
    ['signed, different builders', res('a', claim('builder_id', B1, 'proven_wallet')), res('b', claim('builder_id', B2, 'proven_wallet')), DISTINCT_STRONG],
    ['unsigned, different builders', res('a', claim('builder_id', B1, 'administrative')), res('b', claim('builder_id', B2, 'administrative')), DISTINCT_ADMIN],
    ['no claims', res('a'), res('b'), UNKNOWN],
  ] as const)('%s', (_n, a, b, link) => {
    expect(ownerRelation(a, b)).toEqual(link);
  });
});

// ── isolation ───────────────────────────────────────────────────────────────────────────────

const read = (f: string) => readFileSync(f, 'utf8');

/** Live entrypoints, discovered from what the deploy configs actually run. */
function discoverEntrypoints(): string[] {
  const commands: string[] = [];
  for (const f of readdirSync(ROOT)) {
    if (/^railway.*\.json$/.test(f)) commands.push(String(JSON.parse(read(join(ROOT, f)))?.deploy?.startCommand ?? ''));
    if (/^Dockerfile/.test(f)) for (const m of read(join(ROOT, f)).matchAll(/^CMD\s+\[(.+)\]/gm)) commands.push(String(m[1]).replace(/[",]/g, ' '));
  }
  const scripts = JSON.parse(read(join(ROOT, 'package.json'))).scripts as Record<string, string>;
  for (const k of ['start', 'indexer', 'worker']) if (scripts[k]) commands.push(scripts[k]);
  const files = new Set<string>();
  for (const cmd of commands) {
    for (const tok of cmd.split(/\s+/)) {
      if (!/\.(m?js|ts)$/.test(tok)) continue;
      const src = tok.startsWith('dist/') ? tok.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts') : tok;
      files.add(join(ROOT, src));
    }
  }
  return [...files];
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every local module reachable from `entry` through import / export-from / import() / require(). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(SPEC_RE)) {
      const base = resolve(dirname(file), String(m[1]));
      const noJs = base.replace(/\.(m?js)$/, '');
      for (const cand of [base, `${base}.ts`, `${noJs}.ts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')]) {
        if (existsSync(cand) && statSync(cand).isFile()) { queue.push(cand); break; }
      }
    }
  }
  return seen;
}

/** Files under `dirs` that mention the module by path. */
function referencesTo(needle: string, dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(name) && read(p).includes(needle)) hits.push(relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return hits.sort();
}

describe('anti-farming eligibility: isolation from every live path', () => {
  const entries = discoverEntrypoints();

  test('entrypoint discovery finds the API, the workers and the crons', () => {
    const rel = entries.map((e) => relative(ROOT, e).replace(/\\/g, '/'));
    for (const must of ['src/index.ts', 'src/scripts/start-indexer-service.ts', 'src/scripts/start-proof-drain-service.ts', 'scripts/cron/mint-attestation.mjs']) {
      expect(rel).toContain(must);
    }
    for (const e of entries) expect([relative(ROOT, e), existsSync(e)]).toEqual([relative(ROOT, e), true]);
  });

  test('POSITIVE CONTROL: the walker reaches the live scorer and the owner-distinct shadow from the API entrypoint', () => {
    const live = reachable(join(ROOT, 'src', 'index.ts'));
    expect(live.has(join(ROOT, 'src', 'engine', 'repid-update.ts'))).toBe(true);
    expect(live.has(join(ROOT, 'src', 'services', 'owner-distinct-shadow.ts'))).toBe(true);
    expect(live.size).toBeGreaterThan(50);
  });

  test('no live entrypoint can reach the eligibility module', () => {
    for (const e of entries) expect([relative(ROOT, e), reachable(e).has(MODULE)]).toEqual([relative(ROOT, e), false]);
  });

  test('nothing in src/ or scripts/ names it except itself and its printer; tests may', () => {
    const hits = referencesTo('antifarming-eligibility', [join(ROOT, 'src'), join(ROOT, 'scripts')]);
    expect(hits).toEqual(['scripts/shadow/print-antifarming-table.ts', 'src/shadow/antifarming-eligibility.ts']);
  });

  test('POSITIVE CONTROL: the reference scan finds a name it is pointed at', () => {
    expect(referencesTo('owner-distinct-shadow', [join(ROOT, 'src')])).toContain('src/services/validation-repid-delta.ts');
  });

  test('the module has no I/O, no environment, no flag: it imports types only', () => {
    const code = read(MODULE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imports = code.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const l of imports) expect(l).toMatch(/^\s*import type\b/);
    for (const banned of ['process.env', 'require(', 'import(', 'fetch(', 'console.', 'updateRepId', '.from(', 'Date.now', 'Math.random']) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
  });
});
