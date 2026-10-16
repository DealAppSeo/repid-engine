/**
 * The daily shadow sim is a ruler: a fixed corpus must give the same hash and the same proposals, and a
 * proposal line without its corpus hash must never reach the proposals file. MEASURE-ONLY: no DB, no network.
 */
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDaily, buildCorpus, appendProposals } from '../scripts/repid-sim/daily-shadow';

const rows = [
  { contract_id: 'b', fulfilled: true, satisfaction: 0.5, dispute_verdict: null, self_deal: false, same_owner: false, simulated: false, outcome_rating: null, rater_repid: null },
  { contract_id: 'a', fulfilled: true, satisfaction: null, dispute_verdict: 'provider_at_fault', self_deal: false, same_owner: false, simulated: false, outcome_rating: null, rater_repid: null },
];

describe('repid daily shadow sim', () => {
  it('is deterministic for a fixed corpus: same hash, same proposals, row order irrelevant', () => {
    const a = runDaily('2026-10-15', rows);
    const b = runDaily('2026-10-15', [...rows].reverse());
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.hash).toBe(a.hash);
    expect(b.lines).toEqual(a.lines);
    expect(a.lines.every((l) => l.corpus_hash === a.hash && l.weights_base === 'committed-defaults')).toBe(true);
  });

  it('the hash moves when a real outcome or the date moves', () => {
    const h = buildCorpus('2026-10-15', rows).hash;
    expect(buildCorpus('2026-10-16', rows).hash).not.toBe(h);
    expect(buildCorpus('2026-10-15', [{ ...rows[0], satisfaction: 0.6 }, rows[1]]).hash).not.toBe(h);
  });

  it('refuses to write any proposal line without a corpus hash, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-shadow-'));
    const file = join(dir, 'proposals.jsonl');
    const { lines } = runDaily('2026-10-15', rows);
    expect(() => appendProposals(file, [lines[0]!, { ...lines[1]!, corpus_hash: '' }])).toThrow(/without a corpus hash/);
    expect(existsSync(file)).toBe(false);
  });

  it('appends once per date+hash+id, so a rerun of the same day adds nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daily-shadow-'));
    const file = join(dir, 'proposals.jsonl');
    const { lines } = runDaily('2026-10-15', rows);
    expect(appendProposals(file, lines)).toBe(lines.length);
    expect(appendProposals(file, lines)).toBe(0);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(lines.length);
  });
});
