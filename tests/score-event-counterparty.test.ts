/**
 * COUNTERPARTY FENCE — the column must be WRITTEN, not merely added.
 *
 * A column nobody populates is the `repid_confession_log` failure in a new place: a reviewer
 * reads the schema, sees `counterparty_agent_id`, and concludes the relationship is captured.
 * `repid_confession_log` sat in production with a perfect schema and zero rows because nothing
 * ever called it (LESSONS #3). The point of this suite is that the same thing cannot happen
 * here quietly — every two-party write site is pinned, and the pinning is DERIVED from the
 * call sites rather than from a list someone has to remember to extend.
 *
 * WHAT THE COLUMN IS FOR. Measured 2026-08-11: all 152,130 score events yield 42 recoverable
 * agent pairs, because a two-agent interaction is stored as two unrelated single-agent rows.
 * The relationship is destroyed at write time; no downstream inference recovers it. This is
 * the upstream fix, and its value is entirely prospective — which is exactly the kind of
 * change that rots silently if the write sites are not held.
 */
jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { counterpartyProblem, type ScoreEventInsert } from '../src/scoring/score-event-writer';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8');

const base = (over: Partial<ScoreEventInsert> = {}): ScoreEventInsert =>
  ({ applier: 'trigger', agent_id: 'agent-A', event_type: 'GENESIS', delta: 1, ...over } as ScoreEventInsert);

describe('a self-counterparty is refused at the call site, not at the database', () => {
  // The CHECK would catch it, but as a 23514 from PostgREST several layers away, on a write
  // most callers `await` without reading `ok`. The event would vanish and the log would
  // blame the schema.
  test('agent as its own counterparty is named', () => {
    const p = counterpartyProblem(base({ counterparty_agent_id: 'agent-A' }));
    expect(p).toMatch(/cannot be its own counterparty/);
    expect(p).toMatch(/agent-A/);
  });

  test('a different agent is fine', () => {
    expect(counterpartyProblem(base({ counterparty_agent_id: 'agent-B' }))).toBeNull();
  });

  test.each([undefined, null])('an absent counterparty (%p) is fine — most events have none', (v) => {
    expect(counterpartyProblem(base({ counterparty_agent_id: v as null }))).toBeNull();
  });

  test.each(['', '   ', '\t'])('an empty-ish string %p is refused, never treated as absence', (v) => {
    // This is the shape the DB CHECK cannot see. Silently reading '' as "no counterparty"
    // would discard a relationship the caller believed it had recorded — the failure mode is
    // invisible precisely because the row still lands.
    const p = counterpartyProblem(base({ counterparty_agent_id: v }));
    expect(p).toMatch(/empty string is not "no counterparty"/);
  });
});

describe('the writer refuses the row rather than dropping the field', () => {
  test('insertScoreEvent short-circuits on a bad counterparty', () => {
    // Pinned on the source because exercising it needs a live client. The property: the
    // guard runs BEFORE the row is assembled, so no partial write can happen.
    const src = read('scoring/score-event-writer.ts');
    const guard = src.indexOf('const cpProblem = counterpartyProblem(e);');
    const rowBuild = src.indexOf('const row: Record<string, unknown> = {');
    expect(guard).toBeGreaterThan(-1);
    expect(`guard@${guard} before rowBuild@${rowBuild}`).toBe(
      guard < rowBuild
        ? `guard@${guard} before rowBuild@${rowBuild}`
        : 'THE GUARD RUNS AFTER THE ROW IS BUILT — a bad counterparty could still be written',
    );
  });

  test('the validated field is applied AFTER extra, so extra cannot override it', () => {
    // Letting an unchecked `extra.counterparty_agent_id` win over the checked field would
    // make the guard optional, which is the same failure as a checker you can edit past.
    const src = read('scoring/score-event-writer.ts');
    const extraSpread = src.indexOf('...(e.extra ?? {}),');
    const cpSpread = src.indexOf('...(e.counterparty_agent_id ?');
    expect(cpSpread).toBeGreaterThan(extraSpread);
  });
});

describe('every two-party write site records the other party', () => {
  // Each case names a REAL pairing that existed in the code before this change and recorded
  // nothing. If a site stops passing the counterparty, the pair silently stops being
  // recoverable and nothing else in the system notices.
  test('service contracts: provider records buyer AND buyer records provider', () => {
    const src = read('services/validation-repid-delta.ts');
    expect(src).toMatch(/counterparty_agent_id:\s*contract\.buyer_agent_id/);
    expect(src).toMatch(/counterparty_agent_id:\s*contract\.provider_agent_id/);
  });

  test('challenges: both sides, not just the defender', () => {
    // The defender's row already carried challengerId in metadata; the challenger's row
    // carried nothing, so the pair was only ever visible from one direction.
    const src = read('routes/challenge.ts');
    expect(src).toMatch(/counterparty_agent_id:\s*defenderId/);
    expect(src).toMatch(/counterparty_agent_id:\s*challengerId/);
  });

  test('peer verify: producer, verifier, and the disputed slash', () => {
    const src = read('services/peer-verify-score.ts');
    const hits = [...src.matchAll(/counterpartyAgentId:\s*input\.(\w+)/g)].map((m) => m[1]);
    // producer->verifier, verifier->producer, slash->producer
    expect(hits.sort()).toEqual(['producerAgentId', 'producerAgentId', 'verifierAgentId']);
  });

  test('the peer-verify guarded branch actually forwards it to the writer', () => {
    // Threading a param into a function that ignores it is the most boring way to build an
    // unwired mechanism.
    const src = read('services/peer-verify-score.ts');
    expect(src).toMatch(/counterparty_agent_id:\s*params\.counterpartyAgentId/);
  });

  test('applyValidationEvent lifts it out of metadata onto the column', () => {
    // That writer bypasses insertScoreEvent entirely, so it needs its own lift AND its own
    // self-check — it throws on insert error, so a 23514 there takes the whole delta down.
    const src = read('scoring/pipeline.ts');
    const payload = src.slice(src.indexOf('const insertPayload = {'));
    expect(payload.slice(0, 1200)).toMatch(/counterparty_agent_id:/);
    expect(payload.slice(0, 1200)).toMatch(/!==\s*agent_id/);
  });
});

describe('the migration constrains what the application cannot', () => {
  const sql = readFileSync(
    path.resolve(__dirname, '../migrations/2026-08-11-score-events-counterparty.sql'),
    'utf8',
  );

  test('SET NULL, not CASCADE — losing a counterparty must not delete this agent history', () => {
    // agent_id cascades, which is right. Cascading on the counterparty would delete an
    // agent's own record because some unrelated other agent was removed.
    expect(sql).toMatch(/REFERENCES repid_agents\(id\) ON DELETE SET NULL/);
    const fk = sql.slice(sql.indexOf('repid_score_events_counterparty_fkey'));
    expect(fk.slice(0, 400)).not.toMatch(/ON DELETE CASCADE/);
  });

  test('a CHECK forbids self-counterparty at the storage layer too', () => {
    expect(sql).toMatch(/CHECK \(counterparty_agent_id IS NULL OR counterparty_agent_id <> agent_id\)/);
  });

  test('the backfill only fills where exactly ONE other agent shares the contract', () => {
    // A three-party contract has no single counterparty; picking one would invent a fact.
    // Measured: no such contract exists today — the guard is the difference between "none
    // exist" and "we assumed none exist".
    const occurrences = [...sql.matchAll(/COUNT\(DISTINCT o\.agent_id\)[\s\S]{0,120}?\) = 1/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // candidate count + update
  });

  test('derived values are marked, recorded values are not', () => {
    // A counterparty RECORDED at write time and one INFERRED later are different evidence.
    // The distinction vanishes the moment they share a column undifferentiated.
    expect(sql).toMatch(/'counterparty_source', 'derived:shared_contract'/);
    expect(sql).toMatch(/'counterparty_source', 'derived:metadata_challenger'/);
  });

  test('the backfill is dry-run by default', () => {
    expect(sql).toMatch(/backfill_score_event_counterparty\(p_apply boolean DEFAULT false\)/);
  });

  test('NULL is documented as "not recorded", never as "no counterparty"', () => {
    // The coverage trap: 150,855 NULLs are mostly "nobody was recording", and reading them as
    // "these events had no second party" would turn absent instrumentation into a finding.
    expect(sql).toMatch(/NULL means NOT RECORDED/);
    expect(sql).toMatch(/COMMENT ON COLUMN repid_score_events\.counterparty_agent_id/);
  });

  test('it does not coerce the display-string counterparty metadata into the column', () => {
    // metadata.counterparty holds things like 'mock-fl-buyer-1782493422522'. Coercing those
    // would put fiction in a foreign-keyed column.
    expect(sql).not.toMatch(/metadata->>'counterparty'[^_]/);
    expect(sql).toMatch(/not agent ids/);
  });
});

describe('the generated types know about the column', () => {
  const types = readFileSync(path.resolve(__dirname, '../src/types/database.types.ts'), 'utf8');
  const block = (() => {
    const lines = types.split('\n');
    const start = lines.findIndex((l) => l.trim() === 'repid_score_events: {');
    let depth = 0;
    for (let i = start; i < lines.length; i++) {
      depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
      if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n');
    }
    return '';
  })();

  test('Row, Insert and Update all carry it', () => {
    expect((block.match(/counterparty_agent_id/g) || []).length).toBe(4); // 3 shapes + FK entry
  });

  test('and the foreign key is described', () => {
    expect(block).toMatch(/repid_score_events_counterparty_fkey/);
  });
});
