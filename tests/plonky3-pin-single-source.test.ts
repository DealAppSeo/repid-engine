/**
 * ZKP HYGIENE — Plonky3 single-pin guard (audit item #7b, ZKP Invariant 5).
 *
 * Invariant 5: ONE Plonky3 pin governs ALL Plonky3 circuits. The audit found TWO —
 * the aggregation/prover tier on a Plonky3 git rev (CANON P-026 lockstep) and this
 * repo's `zkp-vault` leaf crate on the crates.io `0.3.0` family. That divergence
 * cannot be safely collapsed tonight (see docs/zkp/PLONKY3_PIN_RECONCILIATION.md), so
 * this guard makes it fail LOUD if it silently changes in either direction:
 *
 *   1. WITHIN zkp-vault, every `p3-*` crate must share one version and one source.
 *      This is the invariant applied to the in-repo crate; it trips the instant a
 *      second pin mechanism (a git source beside the registry, or a second version)
 *      is introduced.
 *
 *   2. The known cross-tier divergence is pinned to the documented state. If someone
 *      collapses zkp-vault onto the canonical git rev, this guard fails and forces the
 *      manifest + doc to be updated to `reconciled` — reconciliation becomes a
 *      reviewed act, never a silent flip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The single canonical Plonky3 pin per ZKP Invariant 5 / CANON P-026 — the git rev
 * the aggregation tier (zkp-postcard prover + @hyperdag/proof-verifier) is locked to.
 * This is the pin everything must ultimately converge on.
 */
const CANONICAL_AGGREGATION_PIN = { mechanism: 'git-rev', value: '27d59f7350' } as const;

/**
 * The pin `zkp-vault`'s leaf tier ACTUALLY resolves today. Divergent from the
 * canonical pin above — deliberately not yet collapsed (KATs are frozen against this
 * release; leaf is not yet wired into aggregation).
 */
const LEAF_TIER_PIN = { mechanism: 'crates.io', value: '0.3.0' } as const;

/**
 * Flip to true ONLY in the same change that collapses zkp-vault onto the canonical
 * pin and re-freezes the leaf KATs. Leaving it false while the pins actually match,
 * or setting it true while they still diverge, both fail the guard below.
 */
const PINS_RECONCILED = false;

const CARGO_LOCK = join(__dirname, '..', 'zkp-vault', 'Cargo.lock');

interface LockPkg {
  name: string;
  version: string;
  source: string | null;
}

/** Minimal Cargo.lock parser: pull name/version/source out of each [[package]] block. */
function parseLock(raw: string): LockPkg[] {
  const text = raw.replace(/\r\n/g, '\n'); // Cargo.lock is CRLF on Windows checkouts.
  const pkgs: LockPkg[] = [];
  for (const block of text.split(/\[\[package\]\]\n/).slice(1)) {
    const name = /^name = "(.+)"/m.exec(block)?.[1];
    const version = /^version = "(.+)"/m.exec(block)?.[1];
    const source = /^source = "(.+)"/m.exec(block)?.[1] ?? null;
    if (name && version) pkgs.push({ name, version, source });
  }
  return pkgs;
}

const p3 = parseLock(readFileSync(CARGO_LOCK, 'utf8')).filter((p) => /^p3-/.test(p.name));

describe('Plonky3 single-pin guard (Invariant 5)', () => {
  it('zkp-vault actually depends on the Plonky3 (p3-*) crate family', () => {
    // Sanity: if this crate stops using p3-* the guard is meaningless — catch that.
    expect(p3.length).toBeGreaterThan(5);
  });

  it('every p3-* crate in zkp-vault shares ONE version (no split pin)', () => {
    const versions = [...new Set(p3.map((p) => p.version))];
    // If this fails: two Plonky3 versions coexist in one crate — Invariant 5 violation.
    expect(versions).toEqual([LEAF_TIER_PIN.value]);
  });

  it('every p3-* crate in zkp-vault shares ONE source (no mixed git+registry pin)', () => {
    const sources = [...new Set(p3.map((p) => p.source))];
    expect(sources).toHaveLength(1);
    // The leaf tier resolves from crates.io today (not a git rev).
    expect(sources[0]).toContain('registry+');
    expect(sources[0]).not.toContain('git+');
  });

  it('pins the KNOWN cross-tier divergence so it cannot silently change', () => {
    const registrySource = p3[0]!.source ?? '';
    const leafOnGitRev = registrySource.includes('git+');
    const actuallyReconciled = leafOnGitRev && p3.every((p) => p.source === registrySource);

    if (PINS_RECONCILED) {
      // Reconciliation was declared — it must be real: zkp-vault must now be on a
      // single git-rev pin. (When you do this, assert the rev equals the canonical
      // pin and re-freeze the leaf KATs in the same change.)
      expect(actuallyReconciled).toBe(true);
    } else {
      // Documented state: leaf tier diverges from the canonical aggregation pin.
      expect(LEAF_TIER_PIN.value).not.toBe(CANONICAL_AGGREGATION_PIN.value);
      expect(LEAF_TIER_PIN.mechanism).not.toBe(CANONICAL_AGGREGATION_PIN.mechanism);
      expect(actuallyReconciled).toBe(false);
      // If zkp-vault has been collapsed onto a git rev but PINS_RECONCILED is still
      // false, this fails — forcing the reconciliation to be recorded, not silent.
      expect(leafOnGitRev).toBe(false);
    }
  });
});
