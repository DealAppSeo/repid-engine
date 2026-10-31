/**
 * Is this ERC-8004 feedback grounded in a payment from the rater? Reads the public chain (and the
 * feedback file, when that is where the payment is named) only: no key, no database, no trust in our
 * servers. Facts and their meaning: src/services/erc8004-grounding.ts.
 *
 *   npx ts-node scripts/ground-feedback.ts <feedbackTx> [--network eip155:8453|eip155:84532]
 *       [--payment <txHash>] [--rpc <url>] [--record <file.json>] [--replay <file.json>] [--json]
 *   npx ts-node scripts/ground-feedback.ts --batch <txs.txt> [--network ...] > results.jsonl
 *
 * --record writes every RPC answer to a tape; --replay answers only from one (offline).
 * --batch reads "<feedbackTx> [paymentTx]" per line and prints one JSON result per line, then a tally on stderr.
 * Exit 0 grounded, 1 not grounded, 2 not measured (batch: 0 when every line ran).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeDataUri } from '../src/services/erc8004-feedback-verify';
import { GROUNDING_NETWORKS, groundFeedback, httpRpc, recordingRpc, replayRpc, type FileFetcher, type Tape } from '../src/services/erc8004-grounding';
import { fetchFeedbackFile } from './verify-feedback-write';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fetchFile: FileFetcher = async (uri) => decodeDataUri(uri) ?? fetchFeedbackFile(uri);

async function main(): Promise<number> {
  const network = arg('network') ?? 'eip155:84532';
  const live = httpRpc(arg('rpc') ?? GROUNDING_NETWORKS[network]?.rpc ?? '');

  const batch = arg('batch');
  if (batch) {
    const tally: Record<string, number> = {};
    const HASH = /^0x[0-9a-fA-F]{64}$/;
    for (const line of readFileSync(batch, 'utf8').split('\n')) {
      const [tx, paymentTx] = line.trim().split(/\s+/);
      if (!tx || !HASH.test(tx)) continue;
      const r = await groundFeedback(live, network, tx, { fetchFile, paymentTx: paymentTx && HASH.test(paymentTx) ? paymentTx : undefined });
      tally[r.grounded] = (tally[r.grounded] ?? 0) + 1;
      console.log(JSON.stringify(r));
    }
    console.error(JSON.stringify(tally));
    return 0;
  }

  const tx = process.argv[2];
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    console.error('usage: ground-feedback.ts <feedbackTx> [--network eip155:84532] [--payment <tx>] [--rpc <url>] [--record f] [--replay f] [--json]');
    return 2;
  }
  const replay = arg('replay');
  const tape: Tape = [];
  const rpc = replay
    ? replayRpc(((j: { tape?: Tape; opname?: Tape }) => j.tape ?? j.opname ?? [])(JSON.parse(readFileSync(replay, 'utf8'))))
    : recordingRpc(live, tape);
  const r = await groundFeedback(rpc, network, tx, { paymentTx: arg('payment'), fetchFile: replay ? undefined : fetchFile });
  const record = arg('record');
  if (record) writeFileSync(record, JSON.stringify({ feedbackTx: r.feedbackTx, network, paymentTx: r.paymentTx, recorded: new Date().toISOString(), result: r, tape }, null, 1));
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`agent ${r.agentId}  rater ${r.rater}  payment ${r.paymentTx ?? '-'} (${r.paymentSource})  payee ${r.payee ?? '-'}  amount ${r.amount ?? '-'}`);
    for (const [f, v] of Object.entries(r.facts)) console.log(`${v.padEnd(13)} ${f.padEnd(27)} ${r.detail[f as keyof typeof r.detail] ?? ''}`);
    console.log(`\ngrounded: ${r.grounded}`);
  }
  return r.grounded === 'yes' ? 0 : r.grounded === 'no' ? 1 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
