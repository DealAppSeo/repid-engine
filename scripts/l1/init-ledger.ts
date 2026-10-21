/**
 * Create the L1 kernel ledger ONCE, holding the owner-signed policy. The only step that creates the file:
 * the executor opens it with `create: false`, so a missing ledger refuses instead of starting empty.
 *
 * Refuses, writing nothing, unless: the signature verifies as the policy's owner, that owner is the one you
 * name with --owner, the policy and the experiment policy are exactly the L1 shape, and no file exists at
 * the path. Reads no key and prints no key.
 *
 *   npx ts-node --transpile-only scripts/l1/init-ledger.ts --ledger <abs path> --signed <l1-signed-policy.json>
 *       --experiment <l1-experiment-policy.json> --owner <0x owner address>
 */
import { readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { l1LedgerPathProblem, l1PairProblems } from '../../src/kernel/l1';
import { parseSignedPolicy, policyHash, verifyOwnerPolicy } from '../../src/kernel/policy';
import { StoreLedger, createJsonlStore } from '../../src/kernel/store';
import type { SignatureChain } from '../../src/services/wallet-signature';

export async function initL1Ledger(o: { ledgerPath: string; signed: unknown; experiment: unknown; pinnedOwner: string; chain?: SignatureChain; recordedAt: string }): Promise<{ ok: true; policy_hash: string } | { ok: false; error: string }> {
  const p = parseSignedPolicy(o.signed);
  if (!p.ok) return { ok: false, error: `not a signed policy: ${p.errors.join('; ')}` };
  const v = await verifyOwnerPolicy(p.signed.policy, p.signed.signature, o.chain);
  if (v.status !== 'VERIFIED') return { ok: false, error: `the signature is ${v.status}: ${v.detail}` };
  if (p.signed.policy.owner.toLowerCase() !== o.pinnedOwner.toLowerCase()) return { ok: false, error: 'the policy was signed by a wallet other than the owner you named' };
  const shape = l1PairProblems(o.experiment, p.signed.policy);
  if (shape.length) return { ok: false, error: `not the L1 shape: ${shape.join('; ')}` };
  await mkdir(dirname(o.ledgerPath), { recursive: true, mode: 0o700 });
  try {
    await (await open(o.ledgerPath, 'wx', 0o600)).close(); // exclusive: never over an existing ledger
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'a ledger already exists at that path; it is never replaced' : 'the ledger file could not be created' };
  }
  await new StoreLedger(createJsonlStore(o.ledgerPath, { create: false })).appendPolicy(p.signed, o.recordedAt);
  return { ok: true, policy_hash: policyHash(p.signed.policy) };
}

if (require.main === module) {
  const arg = (k: string): string => {
    const i = process.argv.indexOf(`--${k}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  (async () => {
    const ledgerPath = arg('ledger');
    const bad = l1LedgerPathProblem(ledgerPath, tmpdir());
    if (bad) throw new Error(bad);
    const r = await initL1Ledger({
      ledgerPath,
      signed: JSON.parse(readFileSync(arg('signed'), 'utf8')),
      experiment: JSON.parse(readFileSync(arg('experiment'), 'utf8')),
      pinnedOwner: arg('owner'),
      recordedAt: new Date().toISOString(),
    });
    if (!r.ok) throw new Error(r.error);
    console.log(`L1 ledger created at ${ledgerPath}\npolicy hash ${r.policy_hash}`);
  })().catch((e) => {
    console.error(`REFUSED: ${(e as Error).message}`);
    process.exit(1);
  });
}
