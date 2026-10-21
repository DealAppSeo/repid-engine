/**
 * Write the three L1 files for review and signing. Signs nothing, sends nothing, reads no key.
 *
 *   npx ts-node --transpile-only scripts/l1/make-policy.ts --owner 0x.. --buyer 0x.. --seller 0x.. [--hours 48]
 *       [--out E:\dev\ops\loop\l1] [--nonce 1] [--per-tx-raw 1000000] [--daily-raw 10000000] [--total-raw 20000000]
 *
 *   <out>/l1-experiment-policy.json   the §2 experiment policy (asset, chain, wallets, count, gas, kill switch)
 *   <out>/l1-typed-data.json          the exact eth_signTypedData_v4 payload. These are the bytes you sign.
 *   <out>/l1-review-sheet.md          the human-readable authorization, rendered from the two files above
 *
 * Caps default to the spec ceilings; any value above one is refused. Existing files are never overwritten.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildL1, renderReviewSheet } from '../../src/kernel/l1';

const arg = (k: string, d?: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  const v = i >= 0 ? process.argv[i + 1] : d;
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
};

try {
  const out = resolve(arg('out', 'E:\\dev\\ops\\loop\\l1'));
  const hours = Number(arg('hours', '48'));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error('--hours must be more than 0 and at most 168 (7 days)');
  const nowS = Math.floor(Date.now() / 1000);
  const oracle = join(__dirname, '..', 'e2e-local', 'arena', 'oracle.ts');
  const a = buildL1({
    subject: `l1-buyer-${randomUUID()}`,
    owner: arg('owner'),
    buyer: arg('buyer'),
    seller: arg('seller'),
    per_tx_raw: arg('per-tx-raw', '1000000'),
    daily_raw: arg('daily-raw', '10000000'),
    total_raw: arg('total-raw', '20000000'),
    tx_per_day: 20,
    max_fee_wei: '100000000000000',
    not_before: nowS,
    expires_at: nowS + Math.round(hours * 3600),
    kill_switch_path: join(out, 'KILL'),
    evaluator_sha256: createHash('sha256').update(readFileSync(oracle)).digest('hex'),
    nonce: arg('nonce', '1'),
  });
  const experiment = JSON.stringify(a.experiment, null, 2);
  const sheet = renderReviewSheet(a.payload, experiment); // refuses before anything is written
  mkdirSync(out, { recursive: true });
  for (const [name, body] of [['l1-experiment-policy.json', experiment], ['l1-typed-data.json', a.payload], ['l1-review-sheet.md', sheet]] as const) {
    writeFileSync(join(out, name), body, { flag: 'wx' });
    console.log(`wrote           ${join(out, name)}`);
  }
  console.log(`payload sha256  ${a.payload_sha256}`);
  console.log(`EIP-712 digest  ${a.digest}`);
  console.log(`subject         ${a.policy.subject}`);
  console.log(`expires         ${new Date(a.policy.expires_at * 1000).toISOString()}`);
} catch (e) {
  console.error(`REFUSED: ${(e as Error).message}`);
  process.exit(1);
}
