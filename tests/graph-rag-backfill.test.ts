/**
 * BACKFILL FENCE — the properties that make a data backfill safe to have run.
 *
 * The derivation itself is SQL and cannot execute in jest, so what is pinned here is the set
 * of properties whose violation is silent and expensive:
 *
 *   1. REVERSIBILITY. Every row is tagged, and the rollback block deletes exactly that tag.
 *      A typo between the two — 'score-events-v1' vs 'score_events_v1' — leaves 188 rows in a
 *      production table with no way to identify them again. Nothing at runtime would notice.
 *   2. DRY-RUN BY DEFAULT. A writer that defaults to writing turns an exploratory call into
 *      a mutation.
 *   3. BOTH EDGE DIRECTIONS. RetrievalService traverses with .eq('from_node_id', …) only, so
 *      a single directed edge is a relationship half the mesh cannot see.
 *   4. THE COUNTS ADD UP. The first draft rendered "32818 outcomes — 0 positive, 12622
 *      negative" and omitted 20,196 zero-delta events, inviting the reader to infer the
 *      remainder was positive. Content that misleads by omission is worse than no content.
 *
 * The live invariants (idempotency, actual insert counts, degree before/after) were verified
 * against the database on 2026-08-11 and are recorded in the migration header; they are not
 * re-asserted here because a test that mocks the database would only be checking the mock.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  toPgVector,
  assertEmbeddingShape,
} from '../src/services/graph-rag/embedding-backfill';
import { EMBEDDING_DIM } from '../src/services/graph-rag/embedding-service';

const MIGRATION = path.resolve(__dirname, '../migrations/2026-08-11-graph-rag-backfill-score-events.sql');
const sql = readFileSync(MIGRATION, 'utf8');

describe('the backfill is reversible, and the rollback targets what the insert wrote', () => {
  // Derived from the file rather than hard-coded here: hard-coding the tag in the test would
  // make the test agree with itself instead of with the migration.
  const defaultTag = /p_tag\s+text\s+DEFAULT\s+'([^']+)'/.exec(sql)?.[1];
  const rollbackTags = [...sql.matchAll(/DELETE FROM (\w+) WHERE metadata->>'backfill_tag' = '([^']+)'/g)];

  test('the function declares a default tag', () => {
    expect(defaultTag).toBeTruthy();
  });

  test('the rollback deletes from BOTH tables', () => {
    expect(rollbackTags.map((m) => m[1]).sort()).toEqual(['agent_memory_edges', 'agent_memory_nodes']);
  });

  test('every rollback delete uses exactly the tag the function writes', () => {
    // The whole point. A mismatch here is undetectable at runtime and unrecoverable by
    // inspection, because nothing else distinguishes a backfilled row from a real one.
    for (const [, table, tag] of rollbackTags) {
      expect(`${table}:${tag}`).toBe(`${table}:${defaultTag}`);
    }
  });

  test('every INSERT in the migration stamps backfill_tag', () => {
    // Derived, not enumerated: a future insert added without the tag is caught by counting,
    // not by someone remembering to extend a list. Hand-maintained enumerations have decayed
    // three times in this repo already.
    const inserts = [...sql.matchAll(/INSERT INTO (agent_memory_\w+)[\s\S]*?RETURNING 1/g)];
    expect(inserts.length).toBeGreaterThanOrEqual(4);
    for (const [block] of inserts) {
      expect(block).toMatch(/'backfill_tag',\s*p_tag/);
    }
  });

  test('nodes also carry a per-row key, so a partial rollback is possible', () => {
    expect(sql).toMatch(/'backfill_key'/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memory_nodes_backfill_key/);
  });
});

describe('the writer does not write unless told to', () => {
  test('p_apply defaults to false', () => {
    expect(sql).toMatch(/p_apply\s+boolean\s+DEFAULT\s+false/);
  });

  test('every insert sits inside the IF p_apply guard', () => {
    const guard = sql.indexOf('IF p_apply THEN');
    const endGuard = sql.indexOf('END IF;', guard);
    expect(guard).toBeGreaterThan(-1);
    for (const m of sql.matchAll(/INSERT INTO agent_memory_\w+/g)) {
      expect(`insert@${m.index} within [${guard},${endGuard}]`).toBe(
        m.index! > guard && m.index! < endGuard
          ? `insert@${m.index} within [${guard},${endGuard}]`
          : `INSERT AT ${m.index} IS OUTSIDE THE p_apply GUARD — a dry run would write`,
      );
    }
  });

  test('a nonsensical threshold is refused rather than coerced', () => {
    expect(sql).toMatch(/IF p_min_events < 1 THEN[\s\S]*?RAISE EXCEPTION/);
  });
});

describe('counterparty edges exist in both directions', () => {
  test('the link join is symmetric', () => {
    // b.self = a.other AND b.other = a.self — the join that produces the reverse side.
    expect(sql).toMatch(/ON b\.self_id = a\.other_id AND b\.other_id = a\.self_id/);
  });

  test('the reason is recorded next to the code, not just in a commit message', () => {
    // Someone "optimising" this to one edge per pair would halve the edge count and silently
    // make half the relationships untraversable. The comment is what stops that review.
    expect(sql).toMatch(/BOTH directions on purpose/);
    expect(sql).toMatch(/from_node_id/);
  });
});

describe('generated content accounts for every event it claims', () => {
  // Each assertion is scoped to ITS OWN template. The first version of this suite matched
  // against the whole file, so deleting the neutral term from the competence template left
  // it green — the counterparty template satisfied the regex. A probe that stays green on a
  // reintroduced bug is not a fence, and the same mis-scoped grep has now failed in this
  // repo four times.
  const competenceTemplate = sql.slice(
    sql.indexOf("'Domain competence: %s."),
    sql.indexOf("Source: repid_score_events.'") + 40,
  );
  const counterpartyTemplate = sql.slice(
    sql.indexOf("'Shared work with %s"),
    sql.indexOf('joined on contract_id.') + 40,
  );

  test('the slices actually isolate the two templates', () => {
    // Guards the guard: if a refactor renames either opening literal, the slices silently
    // become empty strings and every assertion below passes against nothing.
    expect(competenceTemplate).toMatch(/Domain competence/);
    expect(competenceTemplate).not.toMatch(/Shared work with/);
    expect(counterpartyTemplate).toMatch(/Shared work with/);
    expect(counterpartyTemplate).not.toMatch(/Domain competence/);
  });

  test('the competence template reports neutral as well as positive and negative', () => {
    expect(competenceTemplate).toMatch(/%s positive, %s negative, %s neutral \(no RepID change\)/);
  });

  test('the counterparty template does too, and states the event total', () => {
    expect(counterpartyTemplate).toMatch(
      /%s recorded outcomes on that shared work: %s positive, %s negative, %s neutral/,
    );
  });

  test('a HAL mean is always labelled uncalibrated', () => {
    // LESSONS #8. The frozen calibrator is not applied on this path, so the raw number must
    // never appear without its ruler.
    const halClause = /Mean HAL score %s across %s scored events \(RAW, uncalibrated\)/;
    expect(sql).toMatch(halClause);
    // And there is no other rendering of hal that could escape the label.
    const halMentions = [...sql.matchAll(/Mean HAL score/g)];
    expect(halMentions).toHaveLength(1);
  });

  test('negatives are labelled as detected, not self-reported', () => {
    // Measured 2026-08-11: all eight negative event types are detection-shaped. A memory that
    // let a reader assume the agent disclosed them would misrepresent the just-culture state.
    expect(sql).toMatch(/Negatives here were detected, not self-reported/);
  });
});

describe('the half-wired state is reported rather than hidden', () => {
  test('the summary counts nodes without an embedding', () => {
    // graph_rag_match_nodes filters on embedding IS NOT NULL, so a backfilled node is
    // invisible to vector search until the second pass runs. Calling the backfill "done"
    // while this is nonzero is the false-coverage failure this codebase keeps closing.
    expect(sql).toMatch(/'nodes_without_embedding',\s*v_no_embedding/);
  });

  test('and points at the command that fixes it', () => {
    expect(sql).toMatch(/graph-rag:backfill-embeddings/);
  });

  test('that command exists as an npm script', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['graph-rag:backfill-embeddings']).toMatch(/backfill-embeddings\.ts/);
  });
});

describe('embedding CLI argument parsing', () => {
  test('dry-run is the default', () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  test('--apply flips it, --dry-run flips it back', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--apply', '--dry-run']).apply).toBe(false);
  });

  test('--limit and --batch are read as numbers', () => {
    const a = parseArgs(['--limit', '50', '--batch', '7']);
    expect(`${a.limit}/${a.batch}`).toBe('50/7');
  });

  test.each([
    ['--limit', '0'],
    ['--limit', '-1'],
    ['--limit', 'all'],
    ['--batch', '0'],
    ['--batch', 'lots'],
  ])('a nonsensical %s %s is refused, not silently defaulted', (flag, value) => {
    // Coercing NaN to a default would make `--limit all` quietly process 5000 rows.
    expect(() => parseArgs([flag, value])).toThrow(/must be a positive number/);
  });

  test('--tag is passed through', () => {
    expect(parseArgs(['--tag', 'score-events-v1']).tag).toBe('score-events-v1');
  });
});

describe('embedding shape is checked where the cause is', () => {
  const good = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM);

  test('a correct vector passes', () => {
    expect(() => assertEmbeddingShape(good, 'n1')).not.toThrow();
  });

  test('a wrong-length vector names the likely cause', () => {
    // The column would reject this anyway, but as an opaque PostgREST error far from the
    // wrong-model root cause.
    expect(() => assertEmbeddingShape(good.slice(0, 100), 'n1')).toThrow(/expected 384.*wrong model/s);
  });

  test('a NaN slips past a length check, so it is checked separately', () => {
    const bad = [...good];
    bad[3] = Number.NaN;
    expect(() => assertEmbeddingShape(bad, 'n1')).toThrow(/non-finite/);
  });

  test('the pgvector literal is the bracketed form pgvector accepts', () => {
    expect(toPgVector([0.5, -1, 2])).toBe('[0.5,-1,2]');
  });
});

describe('the embedding writer never overwrites an existing vector', () => {
  test('the update is filtered to rows that are still NULL', () => {
    // Without this, a re-run — or a concurrent run — would recompute over nodes another
    // process had already embedded, which is wasted work at best and a race at worst.
    const src = readFileSync(path.resolve(__dirname, '../scripts/graph-rag/backfill-embeddings.ts'), 'utf8');
    const update = src.slice(src.indexOf('.update({ embedding'));
    expect(update.slice(0, 300)).toMatch(/\.is\('embedding', null\)/);
  });

  test('a capped run cannot read as a finished one', () => {
    // --limit bounds the batch; the script re-counts the true outstanding total so the
    // operator sees what is left rather than "done".
    const src = readFileSync(path.resolve(__dirname, '../scripts/graph-rag/backfill-embeddings.ts'), 'utf8');
    expect(src).toMatch(/still without vector/);
    expect(src).toMatch(/NOT COMPLETE/);
  });
});
