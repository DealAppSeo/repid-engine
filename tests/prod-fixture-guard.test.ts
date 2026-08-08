/**
 * The production-extract fixture fence — the permanent #376 fence.
 *
 * #376 committed a real Plonky3 proof, a real agent UUID, and the production table it
 * came from, under tests/fixtures/, as if it were a fixture. It was a live database row,
 * not synthetic. This guard recognises the shape of a production EXTRACT (as opposed to a
 * credential, which gitleaks and the publication guard already handle) and refuses to let
 * it be committed.
 *
 * These tests pin the two load-bearing outcomes the task demands:
 *   - a #376-style fixture (real-looking proof + UUID + prod table, unmarked) is BLOCKED;
 *   - a properly-marked SYNTHETIC / KAT fixture PASSES.
 * plus the binary-blob rule, the provenance-confession override, the marker requirement,
 * the documented env bypass, and — importantly — that ordinary corpora are NOT swept up.
 *
 * NOTE ON FIXTURE SAFETY (#376 fence, applied to this very test): every "bad" fixture
 * below is SYNTHETIC — the UUIDs are `00000000-…`, the proof bytes are `deadbeef`, no real
 * agent id or live proof appears. We test the DETECTOR with fabricated inputs; we never
 * commit a real extract to exercise it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Plain CommonJS: it runs as a hook with no build step available.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../scripts/hooks/prod-fixture-guard.js');
const GUARD = join(__dirname, '..', 'scripts', 'hooks', 'prod-fixture-guard.js');

// ── Fabricated, unmistakably-synthetic building blocks. Never real values. ──
const SYNTH_UUID = '00000000-0000-4000-8000-000000000000';
const SYNTH_PROOF_HEX = 'deadbeef'.repeat(8);

/** Drive the pure decision core directly — no disk, no real proof needed. */
function evalFixture(relPath: string, content: string | null, isBinary?: boolean) {
  return guard.evaluateFixture({ relPath, content, isBinary });
}

describe('the two outcomes the fence must guarantee', () => {
  it('BLOCKS a #376-style fixture: prod table + real-shaped UUID, unmarked', () => {
    const content = JSON.stringify({
      table: 'repid_zkp_proofs',
      agent_id: SYNTH_UUID,
      proof_bytes: SYNTH_PROOF_HEX,
    });
    const v = evalFixture('tests/fixtures/proof-row.json', content);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe(2);
  });

  it('PASSES a properly-marked SYNTHETIC fixture carrying the same shape', () => {
    const content = JSON.stringify({
      _marker: 'SYNTHETIC',
      note: 'generated offline; models the repid_zkp_proofs schema with placeholder ids',
      agent_id: SYNTH_UUID,
      proof_bytes: SYNTH_PROOF_HEX,
    });
    const v = evalFixture('tests/fixtures/proof-row.synthetic.json', content);
    expect(v.blocked).toBe(false);
  });

  it('PASSES the same shape when marked KAT instead of SYNTHETIC', () => {
    const content = JSON.stringify({
      marker: 'KAT',
      current_repid: 1234,
      erc8004_address: '0x0000000000000000000000000000000000000000',
    });
    expect(evalFixture('tests/fixtures/score.kat.json', content).blocked).toBe(false);
  });
});

describe('rule (1) — binary proof blobs under tests/', () => {
  it('BLOCKS an unmarked *.plonky3.bin', () => {
    const v = evalFixture('tests/fixtures/epoch-42.plonky3.bin', null, true);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe(1);
  });

  it('BLOCKS an unmarked *proof*.bin', () => {
    expect(evalFixture('tests/fixtures/agent-proof.bin', null, true).blocked).toBe(true);
  });

  it('PASSES a .bin whose filename marks it synthetic', () => {
    expect(evalFixture('tests/fixtures/leaf-proof.synthetic.bin', null, true).blocked).toBe(false);
  });

  it('PASSES a .bin marked kat', () => {
    expect(evalFixture('tests/fixtures/poseidon2-kat.bin', null, true).blocked).toBe(false);
  });

  it('IGNORES a non-proof binary (no proof/plonky3 hint in the name)', () => {
    // A `.bin` that is clearly not a proof blob is out of scope for rule 1.
    expect(evalFixture('tests/fixtures/logo.bin', null, true).blocked).toBe(false);
  });

  it('classifies proof-blob paths correctly', () => {
    expect(guard.isBinaryProofPath('tests/fixtures/x.plonky3.bin')).toBe(true);
    expect(guard.isBinaryProofPath('tests/fixtures/my-proof.bin')).toBe(true);
    expect(guard.isBinaryProofPath('tests/fixtures/notes.bin')).toBe(false);
    expect(guard.isBinaryProofPath('src/zkp/real.bin')).toBe(false); // not under tests/
  });
});

describe('rule (2) — prod table alongside UUID or provenance', () => {
  it('BLOCKS prod table + UUID with no marker', () => {
    const c = `repid_score_events row for agent ${SYNTH_UUID}`;
    expect(evalFixture('tests/fixtures/scores.json', c).rule).toBe(2);
  });

  it('BLOCKS a provenance confession even WITH a SYNTHETIC marker (extraction wins)', () => {
    const c = JSON.stringify({
      marker: 'SYNTHETIC',
      provenance: 'captured from repid_agents on 2026-08-01',
      agent_id: SYNTH_UUID,
    });
    const v = evalFixture('tests/fixtures/agents.synthetic.json', c);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe(2);
  });

  it('BLOCKS "extracted from production" next to a proof shape', () => {
    const c = '{ "note": "extracted from production", "proof_hash": "0xabc" }';
    expect(evalFixture('tests/fixtures/p.json', c).rule).toBe(2);
  });

  it('allows a prod table NAME alone (schema reference) when marked and no UUID/provenance', () => {
    // Referencing a table name to document the schema of a generated row is fine when
    // the fixture is explicitly marked and carries no real id or provenance clause.
    const c = 'SYNTHETIC row modeling the repid_agents schema; ids are placeholders';
    expect(evalFixture('tests/fixtures/schema-example.json', c).blocked).toBe(false);
  });
});

describe('rule (3) — proof/score/agent shape requires an explicit marker', () => {
  it('BLOCKS an unmarked fixture with a proof_bytes key', () => {
    expect(evalFixture('tests/fixtures/p.json', '{ "proof_bytes": "0xdead" }').rule).toBe(3);
  });

  it('BLOCKS an unmarked fixture with current_repid + erc8004_address', () => {
    const c = '{ "current_repid": 500, "erc8004_address": "0x00" }';
    expect(evalFixture('tests/fixtures/agent.json', c).rule).toBe(3);
  });

  it('BLOCKS an unmarked fixture with a nullifier_hash key', () => {
    expect(evalFixture('tests/fixtures/n.json', '{ "nullifier_hash": "0x1" }').rule).toBe(3);
  });

  it('PASSES the same shape once a SYNTHETIC marker is present', () => {
    expect(
      evalFixture('tests/fixtures/p.json', '{ "_gen": "SYNTHETIC", "proof_bytes": "0xdead" }').blocked,
    ).toBe(false);
  });
});

describe('the honest limits — no sweeping up ordinary corpora or test source', () => {
  it('does NOT flag a HAL/deception corpus that merely mentions "Plonky3" in prose', () => {
    const c = JSON.stringify([
      { id: 'x', input: { text: 'They claimed Plonky3 proves it, definitely.' }, expected: { harm_probability: 0.6 } },
    ]);
    expect(evalFixture('tests/fixtures/hal-regression.json', c).blocked).toBe(false);
  });

  it('does NOT flag a plain UUID with no prod table around it', () => {
    expect(evalFixture('tests/fixtures/ids.json', `{ "session": "${SYNTH_UUID}" }`).blocked).toBe(false);
  });

  it('does NOT scan test SOURCE files that legitimately name tables + UUIDs', () => {
    // A *.test.ts asserting against repid_agents with a UUID literal is not a fixture.
    const c = `expect(row.table).toBe('repid_agents'); const id = '${SYNTH_UUID}';`;
    expect(evalFixture('tests/foo.test.ts', c).blocked).toBe(false);
  });

  it('does NOT apply content rules outside tests/fixtures/', () => {
    const c = `repid_zkp_proofs ${SYNTH_UUID}`;
    expect(evalFixture('tests/data/whatever.json', c).blocked).toBe(false);
  });
});

// ── End-to-end: drive the real CLI over a throwaway git repo (proves --staged/--ci and
//    the documented env bypass, not just the pure core). ──
describe('end-to-end CLI over a scratch repo', () => {
  let repo: string;

  function git(args: string[]) {
    return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  }
  function runGuard(args: string[], env: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [GUARD, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  }
  function writeFixture(rel: string, content: string) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'prodfix-'));
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
  });
  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('--staged BLOCKS a #376-style fixture that has been git-added', () => {
    writeFixture(
      'tests/fixtures/leak.json',
      JSON.stringify({ table: 'repid_zkp_proofs', agent_id: SYNTH_UUID, proof_bytes: SYNTH_PROOF_HEX }),
    );
    git(['add', 'tests/fixtures/leak.json']);
    const r = runGuard(['--staged']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/COMMIT BLOCKED/);
    expect(r.stderr).toMatch(/leak\.json/);
  });

  it('--staged PASSES a marked synthetic fixture', () => {
    writeFixture(
      'tests/fixtures/ok.synthetic.json',
      JSON.stringify({ _marker: 'SYNTHETIC', agent_id: SYNTH_UUID, proof_bytes: SYNTH_PROOF_HEX }),
    );
    git(['add', 'tests/fixtures/ok.synthetic.json']);
    expect(runGuard(['--staged']).code).toBe(0);
  });

  it('--ci walks tests/ and BLOCKS an unmarked binary proof blob on disk', () => {
    writeFixture('tests/fixtures/epoch.plonky3.bin', 'not-really-binary-but-named-so');
    // Not staged — --ci scans the working tree under tests/.
    const r = runGuard(['--ci']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/epoch\.plonky3\.bin/);
  });

  it('ALLOW_PROD_FIXTURE=1 is a documented, LOUD bypass', () => {
    writeFixture(
      'tests/fixtures/leak.json',
      JSON.stringify({ table: 'repid_agents', agent_id: SYNTH_UUID }),
    );
    git(['add', 'tests/fixtures/leak.json']);
    const r = runGuard(['--staged'], { ALLOW_PROD_FIXTURE: '1' });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/SKIPPED via ALLOW_PROD_FIXTURE/);
  });

  it('--ci passes clean on a repo whose only fixture is ordinary prose', () => {
    writeFixture('tests/fixtures/corpus.json', JSON.stringify([{ text: 'ordinary claim' }]));
    expect(runGuard(['--ci']).code).toBe(0);
  });
});
