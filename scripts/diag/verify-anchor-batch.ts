/**
 * verify-anchor-batch — CONTENT audit of the EAS anchor set.
 *
 * WHY THIS EXISTS
 * Prior beats proved the 220 EAS attestations *exist* on Base Sepolia and are un-revoked.
 * That is an existence check: it says an attestation is there, not that it commits to the
 * right proofs. Only 2 of 220 batches had ever been content-verified (Beat 26 §3d/§3e), and
 * each took a bespoke one-off script. This makes the full sweep one command.
 *
 * WHAT "CONTENT-VERIFIED" MEANS HERE — three independent comparisons per batch:
 *   L1  RECOMPUTE  rebuild the merkle root from the batch's proofs' `zk_commitment` values,
 *                  using the SAME builder the worker used (`rootFromCommitments`, the batch's
 *                  own `hash_scheme`) and the SAME leaf order (`created_at ASC, id ASC`,
 *                  eas-anchor-worker.ts:183) → must equal the stored `merkle_root`.
 *   L2  MEMBERSHIP the batch's stored `proof_ids` must be exactly the set of proofs carrying
 *                  that `eas_attestation_uid` — no extras, none missing, count matches.
 *   L3  ON-CHAIN   (--onchain) decode the attestation payload and compare its `merkleRoot`
 *                  field to the recomputed root; also assert un-revoked + expected attester.
 *
 * L1+L2 together are what upgrade "an attestation exists next to these proofs" into "this
 * attestation cryptographically commits to exactly these proofs, in this order". L3 closes
 * the loop against the chain rather than against the DB's own say-so (CLAUDE_RULES r1).
 *
 * READ-ONLY. No writes, no DDL, no key handling — the on-chain leg is `eth_call` only and
 * needs no private key. Exit code 1 on any mismatch so it can gate CI later.
 *
 * USAGE
 *   npx ts-node scripts/diag/verify-anchor-batch.ts                  # all batches, DB-side (L1+L2)
 *   npx ts-node scripts/diag/verify-anchor-batch.ts --onchain        # + L3 (slow: 1 eth_call/batch)
 *   npx ts-node scripts/diag/verify-anchor-batch.ts --limit 5        # first 5 (smoke)
 *   npx ts-node scripts/diag/verify-anchor-batch.ts --uid 0x6f44…    # one batch by uid
 *   npx ts-node scripts/diag/verify-anchor-batch.ts --sample 20      # 20 spread evenly across the run
 *   npx ts-node scripts/diag/verify-anchor-batch.ts --orphans        # uids with proofs but NO batch row
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (read via scripts/verify/lib/db). For --onchain,
 * BASE_SEPOLIA_RPC_URL (default https://sepolia.base.org).
 */
import { AbiCoder, Contract, JsonRpcProvider } from 'ethers';
import { sqlExec, getDb } from '../verify/lib/db';
import { rootFromCommitments } from '../../src/zkp/merkle-root';

const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
const EXPECTED_ATTESTER = '0x4f8ad3fb35473b6dea0559ffbbde034e2db504fb';
/** The attest payload schema from src/services/eas-attestation-service.ts:60. Index 2 = merkleRoot. */
const PAYLOAD_TYPES = ['string', 'string', 'bytes32', 'uint256', 'string', 'uint64'];
const PAYLOAD_MERKLE_ROOT_INDEX = 2;

interface BatchRow {
  merkle_root: string;
  hash_scheme: string;
  eas_uid: string | null;
  proof_id_min: string | number;
  proof_id_max: string | number;
  proof_count: number;
  proof_ids: number[] | string;
  created_at: string;
}

type Level = 'RECOMPUTE' | 'MEMBERSHIP' | 'ONCHAIN';

interface BatchVerdict {
  uid: string;
  createdAt: string;
  proofCount: number;
  /** null = not run (e.g. --onchain off) */
  results: Partial<Record<Level, { ok: boolean; detail: string }>>;
}

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    onchain: argv.includes('--onchain'),
    orphans: argv.includes('--orphans'),
    limit: get('--limit') ? Number(get('--limit')) : undefined,
    sample: get('--sample') ? Number(get('--sample')) : undefined,
    uid: get('--uid'),
    json: argv.includes('--json'),
    negativeControl: argv.includes('--negative-control'),
  };
}

/**
 * NEGATIVE CONTROL — a check that cannot fail proves nothing.
 * With --negative-control the recomputation drops the batch's LAST leaf before building the
 * root. Every batch must then FAIL L1 (exit 1). If a "verified" run and a tampered run both
 * come back green, the comparison is broken, not the data. Dropping a leaf (rather than
 * flipping a byte) also exercises the odd-level duplicate-last rule, which is where a
 * Bitcoin-style tree is most likely to silently agree with itself.
 */
function applyNegativeControl(commitments: string[]): string[] {
  return commitments.length > 1 ? commitments.slice(0, -1) : ['0xdeadbeef'];
}

/** Postgres bigint[] arrives as a JS array via exec_sql's JSON, or as '{1,2,3}' text. Normalise. */
function toIdArray(v: number[] | string): number[] {
  if (Array.isArray(v)) return v.map(Number);
  return String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(Number);
}

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function fetchBatches(a: ReturnType<typeof parseArgs>): Promise<BatchRow[]> {
  const where = a.uid ? `where eas_uid = '${a.uid.replace(/'/g, "''")}'` : '';
  const rows = await sqlExec<BatchRow>(
    `select merkle_root, hash_scheme, eas_uid, proof_id_min, proof_id_max,
            proof_count, proof_ids, created_at
       from eas_anchor_batches
       ${where}
      order by created_at asc, proof_id_min asc`,
  );
  if (a.sample && rows.length > a.sample) {
    // Even spread across the run, not the first N — a head-only sample would only ever
    // exercise the batches written closest to the failure being investigated.
    const step = (rows.length - 1) / (a.sample - 1);
    return Array.from({ length: a.sample }, (_, i) => rows[Math.round(i * step)]!);
  }
  return a.limit ? rows.slice(0, a.limit) : rows;
}

/**
 * Uids carried by real proofs that have NO row in eas_anchor_batches — the Beat 26 class of
 * bookkeeping gap. These are still content-verifiable: the leaf set is reconstructed from
 * repid_zkp_proofs in the worker's ordering, and checked against the ON-CHAIN root (there is
 * no stored root to compare to, so --onchain is the only meaningful oracle for these).
 */
async function fetchOrphanUids(): Promise<Array<{ uid: string; proof_count: number }>> {
  return sqlExec<{ uid: string; proof_count: number }>(
    `select p.eas_attestation_uid as uid, count(*)::int as proof_count
       from repid_zkp_proofs p
      where p.proof_bytes is not null
        and p.eas_attestation_uid is not null
        and not exists (select 1 from eas_anchor_batches b where b.eas_uid = p.eas_attestation_uid)
      group by 1
      order by min(p.id)`,
  );
}

/** Commitments for an explicit id list, returned in the SAME order as `ids`. */
async function commitmentsByIds(ids: number[]): Promise<{ ordered: string[]; missing: number[] }> {
  const rows = await sqlExec<{ id: number; zk_commitment: string | null }>(
    `select id, zk_commitment from repid_zkp_proofs where id = any(array[${ids.join(',')}]::bigint[])`,
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r.zk_commitment]));
  const ordered: string[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (c === undefined || c === null) missing.push(id);
    else ordered.push(c);
  }
  return { ordered, missing };
}

/** Commitments for a uid in the worker's canonical leaf order (created_at ASC, id ASC). */
async function commitmentsByUid(uid: string): Promise<{ ids: number[]; commitments: string[] }> {
  const rows = await sqlExec<{ id: number; zk_commitment: string }>(
    `select id, zk_commitment from repid_zkp_proofs
      where eas_attestation_uid = '${uid.replace(/'/g, "''")}'
        and zk_commitment is not null
      order by created_at asc, id asc`,
  );
  return { ids: rows.map((r) => Number(r.id)), commitments: rows.map((r) => r.zk_commitment) };
}

let easContract: Contract | null = null;
function eas(): Contract {
  if (easContract) return easContract;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  easContract = new Contract(
    EAS_CONTRACT,
    ['function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))'],
    new JsonRpcProvider(rpc),
  );
  return easContract;
}

/** Decode the attestation and pull out the committed merkle root. Absent uid → onchainRoot null. */
async function onChainRoot(uid: string): Promise<{ root: string | null; attester: string; revoked: boolean; time: number }> {
  const att: any = await (eas() as any).getAttestation(uid);
  // An ABSENT attestation returns an all-zero struct — that is how the negative control works.
  if (!att || att.uid === '0x' + '0'.repeat(64)) return { root: null, attester: '', revoked: false, time: 0 };
  const dec = AbiCoder.defaultAbiCoder().decode(PAYLOAD_TYPES, att.data);
  return {
    root: String(dec[PAYLOAD_MERKLE_ROOT_INDEX]),
    attester: String(att.attester),
    revoked: BigInt(att.revocationTime) !== 0n,
    time: Number(att.time),
  };
}

async function verifyBatch(b: BatchRow, opts: { onchain: boolean; negativeControl?: boolean }): Promise<BatchVerdict> {
  const uid = b.eas_uid ?? '(null uid)';
  const v: BatchVerdict = { uid, createdAt: b.created_at, proofCount: b.proof_count, results: {} };
  const storedIds = toIdArray(b.proof_ids);

  // ---- L2 MEMBERSHIP: stored proof_ids == the proofs actually carrying this uid ----
  if (b.eas_uid) {
    const live = await commitmentsByUid(b.eas_uid);
    const storedSet = new Set(storedIds);
    const liveSet = new Set(live.ids);
    const extra = [...storedSet].filter((i) => !liveSet.has(i));
    const missing = [...liveSet].filter((i) => !storedSet.has(i));
    const countOk = storedIds.length === b.proof_count && live.ids.length === b.proof_count;
    const ok = extra.length === 0 && missing.length === 0 && countOk;
    v.results.MEMBERSHIP = {
      ok,
      detail: ok
        ? `${b.proof_count} ids match the uid's proof set exactly`
        : `stored=${storedIds.length} live=${live.ids.length} declared=${b.proof_count}` +
          (extra.length ? ` extra=[${extra.slice(0, 5).join(',')}${extra.length > 5 ? '…' : ''}]` : '') +
          (missing.length ? ` missing=[${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}]` : ''),
    };
  }

  // ---- L1 RECOMPUTE: rebuild the root from the stored ids, in stored order ----
  let recomputed: string | null = null;
  try {
    const { ordered, missing } = await commitmentsByIds(storedIds);
    if (missing.length) {
      v.results.RECOMPUTE = { ok: false, detail: `${missing.length} proof rows have no zk_commitment (ids ${missing.slice(0, 5).join(',')}…)` };
    } else {
      const leaves = opts.negativeControl ? applyNegativeControl(ordered) : ordered;
      recomputed = rootFromCommitments(leaves, b.hash_scheme).root;
      const ok = eq(recomputed, b.merkle_root);
      v.results.RECOMPUTE = {
        ok,
        detail: ok
          ? `root ${recomputed.slice(0, 12)}… == stored (${b.hash_scheme}, ${leaves.length} leaves)`
          : `MISMATCH recomputed=${recomputed} stored=${b.merkle_root}`,
      };
    }
  } catch (e: any) {
    v.results.RECOMPUTE = { ok: false, detail: `recompute threw: ${e?.message ?? e}` };
  }

  // ---- L3 ON-CHAIN: the attestation's own committed root ----
  if (opts.onchain && b.eas_uid) {
    try {
      const chain = await onChainRoot(b.eas_uid);
      if (chain.root === null) {
        v.results.ONCHAIN = { ok: false, detail: 'attestation ABSENT on chain' };
      } else {
        const rootOk = eq(chain.root, recomputed ?? b.merkle_root);
        const attesterOk = eq(chain.attester, EXPECTED_ATTESTER);
        const ok = rootOk && attesterOk && !chain.revoked;
        v.results.ONCHAIN = {
          ok,
          detail: ok
            ? `on-chain root == ${recomputed ? 'recomputed' : 'stored'}; attester ok; un-revoked`
            : `${rootOk ? '' : `root MISMATCH chain=${chain.root} local=${recomputed ?? b.merkle_root}; `}` +
              `${attesterOk ? '' : `attester=${chain.attester} (expected ${EXPECTED_ATTESTER}); `}` +
              `${chain.revoked ? 'REVOKED; ' : ''}`,
        };
      }
    } catch (e: any) {
      v.results.ONCHAIN = { ok: false, detail: `eth_call failed: ${e?.message ?? e}` };
    }
  }

  return v;
}

/** Orphan uids have no stored root — the chain is the only oracle, so --onchain is required. */
async function verifyOrphan(uid: string, opts: { onchain: boolean }): Promise<BatchVerdict> {
  const v: BatchVerdict = { uid, createdAt: '(no batch row)', proofCount: 0, results: {} };
  const { ids, commitments } = await commitmentsByUid(uid);
  v.proofCount = ids.length;
  let recomputed: string | null = null;
  try {
    recomputed = rootFromCommitments(commitments, 'keccak256').root;
  } catch (e: any) {
    v.results.RECOMPUTE = { ok: false, detail: `recompute threw: ${e?.message ?? e}` };
    return v;
  }
  v.results.RECOMPUTE = { ok: true, detail: `root ${recomputed.slice(0, 12)}… from ${ids.length} leaves (no stored root to compare — orphan)` };
  if (!opts.onchain) {
    v.results.ONCHAIN = { ok: false, detail: 'orphan uid has no stored root; re-run with --onchain (the chain is the only oracle here)' };
    return v;
  }
  try {
    const chain = await onChainRoot(uid);
    if (chain.root === null) {
      v.results.ONCHAIN = { ok: false, detail: 'attestation ABSENT on chain' };
    } else {
      const ok = eq(chain.root, recomputed) && eq(chain.attester, EXPECTED_ATTESTER) && !chain.revoked;
      v.results.ONCHAIN = { ok, detail: ok ? 'on-chain root == recomputed; attester ok; un-revoked' : `chain=${chain.root} recomputed=${recomputed} attester=${chain.attester} revoked=${chain.revoked}` };
    }
  } catch (e: any) {
    v.results.ONCHAIN = { ok: false, detail: `eth_call failed: ${e?.message ?? e}` };
  }
  return v;
}

function render(verdicts: BatchVerdict[], opts: { onchain: boolean }): number {
  let failures = 0;
  const counts: Record<string, { ok: number; bad: number }> = {};
  for (const v of verdicts) {
    const bad = Object.entries(v.results).filter(([, r]) => !r.ok);
    for (const [lvl, r] of Object.entries(v.results)) {
      counts[lvl] ??= { ok: 0, bad: 0 };
      r.ok ? counts[lvl]!.ok++ : counts[lvl]!.bad++;
    }
    if (bad.length) {
      failures++;
      console.log(`\n  ✗ ${v.uid}  (${v.createdAt}, ${v.proofCount} proofs)`);
      for (const [lvl, r] of bad) console.log(`      ${lvl}: ${r.detail}`);
    }
  }
  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`  batches checked : ${verdicts.length}`);
  for (const [lvl, c] of Object.entries(counts)) {
    console.log(`  ${lvl.padEnd(11)}     : ${c.ok} pass / ${c.bad} FAIL`);
  }
  if (!opts.onchain) console.log(`  (on-chain leg NOT run — pass --onchain to verify against Base Sepolia)`);
  console.log(`  VERDICT         : ${failures === 0 ? 'ALL CONTENT-VERIFIED ✅' : `${failures} batch(es) FAILED ❌`}`);
  console.log('─────────────────────────────────────────────────────────');
  return failures;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!getDb()) {
    console.error('no Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_KEY) — cannot run');
    process.exit(2);
  }

  const verdicts: BatchVerdict[] = [];

  if (a.orphans) {
    const orphans = await fetchOrphanUids();
    console.log(`verify-anchor-batch — ${orphans.length} ORPHAN uid(s) (proofs carry them, no eas_anchor_batches row)`);
    for (const o of orphans) verdicts.push(await verifyOrphan(o.uid, { onchain: a.onchain }));
  } else {
    const batches = await fetchBatches(a);
    console.log(
      `verify-anchor-batch — ${batches.length} batch(es)` +
        (a.sample ? ` (evenly-spread sample of ${a.sample})` : '') +
        (a.onchain ? ' · L1 RECOMPUTE + L2 MEMBERSHIP + L3 ON-CHAIN' : ' · L1 RECOMPUTE + L2 MEMBERSHIP'),
    );
    if (a.negativeControl) console.log('  ⚠ NEGATIVE CONTROL ACTIVE — last leaf dropped; every batch MUST fail L1 below.');
    let n = 0;
    for (const b of batches) {
      verdicts.push(await verifyBatch(b, { onchain: a.onchain, negativeControl: a.negativeControl }));
      if (++n % 25 === 0) process.stdout.write(`  …${n}/${batches.length}\n`);
    }
  }

  if (a.json) console.log(JSON.stringify(verdicts, null, 2));
  const failures = render(verdicts, { onchain: a.onchain });

  if (a.negativeControl) {
    // Inverted semantics: the control PASSES only if every batch was rejected. A green
    // negative control would mean the comparison is broken and the normal run's ✅ is empty.
    const allFailed = failures === verdicts.length && verdicts.length > 0;
    console.log(
      allFailed
        ? `  NEGATIVE CONTROL: ✅ all ${verdicts.length} rejected — the check discriminates.`
        : `  NEGATIVE CONTROL: ❌ ${verdicts.length - failures} tampered batch(es) still PASSED — the check is broken.`,
    );
    process.exit(allFailed ? 0 : 1);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-anchor-batch FAILED:', e?.message ?? e);
  process.exit(2);
});
