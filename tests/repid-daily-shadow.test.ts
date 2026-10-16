/**
 * The daily shadow sim is a ruler. Each block below must be able to go red:
 *   - same corpus => same hash and proposals; any input that determines the result => a different hash
 *   - a line without its hash, or a different body under the same hash, never reaches the file
 *   - "propose" is impossible while any anti-gaming margin falls or an objective regresses
 * MEASURE-ONLY: no DB, no network.
 */
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDaily, buildCorpus, appendProposals, applyDelta, objectives, antiGaming, verdictOf } from '../scripts/repid-sim/daily-shadow';
import { COMMITTED_TARIFF } from '../scripts/repid-sim/a2a-ring-sim';

const rows = [
  { contract_id: 'b', fulfilled: true, satisfaction: 0.5, dispute_verdict: null, self_deal: false, same_owner: false, simulated: false, outcome_rating: null, rater_repid: null },
  { contract_id: 'a', fulfilled: true, satisfaction: null, dispute_verdict: 'provider_at_fault', self_deal: false, same_owner: false, simulated: false, outcome_rating: null, rater_repid: null },
];
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'daily-shadow-')), 'proposals.jsonl');

describe('corpus hash is the ruler', () => {
  it('is deterministic for a fixed corpus: same hash, same proposals, row order irrelevant', () => {
    const a = runDaily('2026-10-15', rows);
    const b = runDaily('2026-10-15', [...rows].reverse());
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.hash).toBe(a.hash);
    expect(b.lines).toEqual(a.lines);
    expect(a.lines.every((l) => l.corpus_hash === a.hash && l.weights_base === 'committed-defaults')).toBe(true);
  });

  it('moves when the date or a real outcome moves', () => {
    const h = buildCorpus('2026-10-15', rows).hash;
    expect(buildCorpus('2026-10-16', rows).hash).not.toBe(h);
    expect(buildCorpus('2026-10-15', [{ ...rows[0]!, satisfaction: 0.6 }, rows[1]!]).hash).not.toBe(h);
  });

  it('moves when one tariff constant moves (the tariff is bound, not assumed)', () => {
    const h = buildCorpus('2026-10-15', rows).hash;
    expect(buildCorpus('2026-10-15', rows, applyDelta(COMMITTED_TARIFF, { 'fulfilled.provider': COMMITTED_TARIFF.fulfilled.provider + 1 })).hash).not.toBe(h);
    expect(buildCorpus('2026-10-15', rows, applyDelta(COMMITTED_TARIFF, { raterWeightMax: COMMITTED_TARIFF.raterWeightMax + 0.5 })).hash).not.toBe(h);
  });

  it('binds the grid, RATER_WEIGHT, the clamp and the code into the hashed corpus', () => {
    const { corpus } = buildCorpus('2026-10-15', rows);
    expect(corpus.grid.length).toBeGreaterThan(0);
    expect(corpus.rater_weight).toEqual({ min: expect.any(Number), pivot: expect.any(Number) });
    expect(corpus.clamp).toHaveLength(2);
    expect(corpus.code_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('appendProposals', () => {
  it('refuses any line without a corpus hash, and writes nothing', () => {
    const file = tmpFile();
    const { lines } = runDaily('2026-10-15', rows);
    expect(() => appendProposals(file, [lines[0]!, { ...lines[1]!, corpus_hash: '' }])).toThrow(/without a corpus hash/);
    expect(existsSync(file)).toBe(false);
  });

  it('a rerun of the same day adds nothing', () => {
    const file = tmpFile();
    const { lines } = runDaily('2026-10-15', rows);
    expect(appendProposals(file, lines)).toBe(lines.length);
    expect(appendProposals(file, lines)).toBe(0);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(lines.length);
  });

  it('refuses loudly when a different body arrives under the same date|hash|id, and writes nothing', () => {
    const file = tmpFile();
    const { lines } = runDaily('2026-10-15', rows);
    appendProposals(file, lines);
    const before = readFileSync(file, 'utf8');
    const flipped = { ...lines[0]!, verdict: lines[0]!.verdict === 'propose' ? ('reject' as const) : ('propose' as const) };
    expect(() => appendProposals(file, [flipped])).toThrow(/DIFFERENT body/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('verdictOf', () => {
  const ob = objectives(COMMITTED_TARIFF, []);
  const ab = antiGaming(COMMITTED_TARIFF, []);
  const oa = objectives(applyDelta(COMMITTED_TARIFF, { 'dispute.provider_at_fault.provider': -200 }), []); // newly meets P3_full

  it('positive control: newly meets an objective, no margin moves => propose', () => {
    expect(ob.checks.P3_full!.pass).toBe(false);
    expect(oa.checks.P3_full!.pass).toBe(true);
    expect(verdictOf(ob, oa, ab, ab).verdict).toBe('propose');
  });

  it('rejects when a margin that was ALREADY negative falls further, and names it', () => {
    expect(ab.margins.collusion).toBeLessThanOrEqual(0);
    const v = verdictOf(ob, oa, ab, { ...ab, margins: { ...ab.margins, collusion: ab.margins.collusion - 1 } });
    expect(v.verdict).toBe('reject');
    expect(v.reason).toMatch(/anti-gaming margin falls: collusion/);
  });

  it('rejects when a positive margin shrinks but stays positive', () => {
    expect(ab.margins.fabrication).toBeGreaterThan(1);
    const v = verdictOf(ob, oa, ab, { ...ab, margins: { ...ab.margins, fabrication: ab.margins.fabrication - 1 } });
    expect(v.verdict).toBe('reject');
    expect(v.reason).toMatch(/anti-gaming margin falls: fabrication/);
  });

  it('rejects when an objective regresses', () => {
    const v = verdictOf(oa, ob, ab, ab); // P3_full true -> false
    expect(v.verdict).toBe('reject');
    expect(v.reason).toMatch(/objective P3_full regresses/);
  });

  it('end to end: dispute-200 meets P3_full but lowers honest margins, so it is rejected with the margins named', () => {
    const line = runDaily('2026-10-15', rows).lines.find((l) => l.id === 'dispute-200')!;
    expect(line.objective_after.checks.P3_full!.pass).toBe(true);
    expect(line.verdict).toBe('reject');
    expect(line.reason).toMatch(/anti-gaming margin falls/);
    expect(line.reason).not.toMatch(/nothing regresses/);
  });
});
