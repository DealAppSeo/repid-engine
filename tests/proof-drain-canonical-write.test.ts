/**
 * The canonical proof write must not send a column the store cannot accept.
 *
 * WHAT HAPPENED. A provenance block landed 2026-08-09 adding job_id, event_id and contract_id
 * to the repid_zkp_proofs insert. `repid_proof_queue.event_id` is BIGINT (it points at
 * repid_score_events); `repid_zkp_proofs.event_id` is UUID. Postgres rejected the whole INSERT
 * with 42804, the catch swallowed it, and the queue row stayed `completed`.
 *
 * MEASURED 2026-08-30, three weeks later: across 79,062 rows in repid_zkp_proofs, job_id,
 * event_id and contract_id are populated ZERO times — the feature never once succeeded — while
 * 100% of completed queue jobs carry an event_id. The prover kept minting 2-4 real proofs a day
 * into the queue and the passport, CLI and badge kept serving the newest surviving row.
 *
 * WHY THE TEST IS SHAPED LIKE THIS. The bug is a type disagreement between two tables, which no
 * unit test can observe directly. What it CAN pin is the consequence: the row this service
 * builds must never carry `event_id` while those types disagree. If someone re-adds it — the
 * change looks obviously correct, it is restoring provenance — this fails and says why.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'src', 'services', 'proof-drain-service.ts'), 'utf8');

/** The insert row literal built in insertCanonicalProof. */
function canonicalInsertBlock(): string {
  const start = SRC.indexOf('const insertRow: Record<string, unknown> = {');
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('};', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('repid_zkp_proofs canonical write', () => {
  it('does NOT send event_id — queue bigint vs store uuid is a guaranteed 42804', () => {
    const block = canonicalInsertBlock();
    // Comments explaining the omission are expected and fine; an actual assignment is not.
    const assigns = block
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(assigns).not.toMatch(/event_id\s*:/);
  });

  it('still sends the provenance columns whose types DO match', () => {
    const assigns = canonicalInsertBlock()
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // job_id is text↔text and contract_id is uuid↔uuid — both land fine, and dropping them
    // would quietly widen an unrelated gap while fixing this one.
    expect(assigns).toMatch(/job_id\s*:/);
    expect(assigns).toMatch(/contract_id\s*:/);
    expect(assigns).toMatch(/agent_id\s*:/);
  });

  it('a failed canonical insert is logged with a stable, greppable marker', () => {
    // "Non-fatal" must not mean "invisible". This marker is what a log search or alert rule
    // keys on; without it the failure is a sentence in a stream nobody reads — which is
    // precisely how this ran for three weeks behind a queue reporting `completed`.
    expect(SRC).toContain('[ProofDrain][CANONICAL_WRITE_FAILED]');
  });

  it('the log names the consequence, not just the error', () => {
    // A reader of the log must learn that the proof is real and merely unreadable downstream,
    // otherwise the natural reading is "proof generation is broken" — the exact wrong diagnosis
    // this bug produced on first inspection.
    expect(SRC).toMatch(/NOT readable by passport\/CLI\/badge/);
  });
});
