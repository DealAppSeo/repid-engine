/**
 * zk-truth-table.ts — P-15: what the real `plonky3_range_check` proofs actually prove.
 *
 * READ-ONLY. Supabase SELECTs and Base Sepolia eth_call only: no writes, no sends, no DDL.
 * It never prints or writes proof bytes or agent ids (the #376 fence: this repo is PUBLIC).
 *
 * WHAT A VERIFIED PROOF STATES (hyperdag-proof-verifier src/lib.rs at the pinned rev ec3930a):
 *   public values = agent_id (16 bytes) | threshold | repid_score. All three are PUBLIC.
 *   witness       = the 16 bits of (repid_score - threshold - 1).
 *   So it shows threshold < repid_score <= threshold + 65536 for numbers the statement already
 *   discloses. score and threshold sit in constraints and are bound. agent_id sits in NO constraint,
 *   only the transcript, and the trace is one row (constant polynomials), so its binding is the
 *   8-bit query proof-of-work: about 1 in 256 foreign agent ids verify the same bytes (measured
 *   below as `agent_binding_rate`). `tier` is NOT bound. Nothing is hidden, and nothing in the
 *   proof says the score is the agent's real score: that is the event leg. Anyone holding the
 *   public prover can make a valid proof for any agent and any score above any threshold.
 *
 * LEGS PER ROW, each VERIFIED / FAILED / NOT_CHECKED, never inferred:
 *   verify    real WASM verifier on {agent_id, tier, repid_score, threshold}; agent_id/tier
 *             fall back to the row's columns when the stored statement omits them
 *   unique    id, zk_commitment and job_id (when present) each name exactly one row
 *   event     the proven score equals repid_after of the agent's latest repid_score_events row
 *             at or before the proof. A value match on the ledger, not a cryptographic binding.
 *             The job_id → zk_proof_id link, when present, is reported beside it as event_link.
 *   anchor    getAttestation(uid) on EAS returns that uid, not revoked
 *   included  the merkle root recomputed from the commitments the DB says this uid anchored
 *             equals the root in the on-chain payload
 *   binding   proof <-> anchored leaf. NOT_CHECKED for evidence-bundle@1 (D-150): the leaf
 *             hashes a nonce and proverCommitment that are not stored.
 *
 * MODES
 *   --seed <s> [--per-stratum 10]  rank = sha256("<s>:<id>") ascending, first k per statement
 *                                  shape (sorted jsonb keys). The SQL that redraws it is printed.
 *   --ids <file|list>              explicit "id" or "id:rows" list, e.g. the census of one row
 *                                  per distinct (proof bytes, agent, score, threshold)
 *   --all-anchors                  also check EVERY distinct uid in the population (anchor + included
 *                                  become counts over all rows, not a sample estimate)
 *   --bind-n <n>                   foreign agent ids tried for agent_binding_rate (default 256)
 *   --max-id <n>                   population cutoff (default: current max); always printed
 *   --out <path>                   JSON results (no proof bytes, no agent ids). Keep it OUT of the repo.
 *   --rpc <url>                    default https://sepolia.base.org
 *
 * ENV: SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY).
 * PowerShell, from the repo root after `npm install --legacy-peer-deps`:
 *   node --env-file=<path to your env file> -r ts-node/register scripts/zkp/zk-truth-table.ts --seed p15-2026-11-13
 *
 * EXIT: 0 every leg and control ran and none FAILED (binding stays NOT_CHECKED by construction) ·
 *       1 a leg FAILED or a control broke · 2 NOT_CHECKED: no credentials, the positive control did
 *       not verify, or any other leg or control could not run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AbiCoder, Contract, JsonRpcProvider } from 'ethers';
import { verifyRangeCheck } from '../../src/zkp/range-check-verify';
import { rootFromCommitments } from '../../src/zkp/merkle-root';

export type Verdict = 'VERIFIED' | 'FAILED' | 'NOT_CHECKED';

const EAS = '0x4200000000000000000000000000000000000021';
const EAS_ABI = [
  'function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
];
const PAYLOAD = ['string', 'string', 'bytes32', 'uint256', 'string', 'uint64']; // eas-attestation-service PROOF_SCHEMA_DEF
const FAKE_UID = '0x' + 'dead'.repeat(15) + 'beef';
const BINDING_REASON =
  'evidence-bundle@1: zk_commitment = sha256(agentId|score|tier|nonce|proverCommitment); nonce and proverCommitment are not stored, so the anchored leaf cannot be recomputed from the proof statement (D-150)';
const PROVES = 'threshold < repid_score <= threshold + 65536, all public; agent_id bound only by an 8-bit PoW; tier not bound';
const ZERO_UID = '0x' + '0'.repeat(64);

// ── pure helpers (tests/zk-truth-table-sample.test.ts) ─────────────────────────────────────────
export function rankKey(seed: string, id: number): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}
/** Sorted keys. A statement with no keys ({} or null) is '(none)', the same group as the SQL's NULL partition. */
export function shapeOf(statement: unknown): string {
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return '(none)';
  return Object.keys(statement).sort().join(',') || '(none)';
}
/** The SQL that redraws drawSample's rows. The seed is quoted for SQL, so a ' in it cannot break the query. */
export function redrawSql(seed: string, maxId: number, k: number): string {
  const s = seed.replace(/'/g, "''");
  return `select id from (select id, row_number() over (partition by (select string_agg(k, ',' order by k) from jsonb_object_keys(statement) k)
    order by encode(sha256(convert_to('${s}:' || id, 'UTF8')), 'hex')) rn from repid_zkp_proofs
    where scheme='plonky3_range_check' and is_real and id <= ${maxId}) x where rn <= ${k};`;
}
/** First k ids per shape by rankKey; returned in rank order. */
export function drawSample(pop: { id: number; shape: string }[], seed: string, k: number): number[] {
  const ranked = pop.map((p) => ({ ...p, key: rankKey(seed, p.id) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = new Map<string, number>();
  const out: number[] = [];
  for (const r of ranked) {
    const n = taken.get(r.shape) ?? 0;
    if (n < k) { out.push(r.id); taken.set(r.shape, n + 1); }
  }
  return out;
}
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function flipByte(proofB64: string, at?: number): string {
  const b = Buffer.from(proofB64, 'base64');
  const i = at ?? Math.floor(b.length / 2);
  b[i] = b[i]! ^ 0xff;
  return b.toString('base64');
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Row {
  id: number; agent_id: string | null; tier_proven: string; statement: Record<string, unknown> | null;
  proof_bytes: string | null; zk_commitment: string | null; eas_attestation_uid: string | null;
  job_id: string | null; event_id: string | null; created_at: string;
}

function canonical(row: Row) {
  const s = row.statement ?? {};
  return {
    agent_id: String(s['agent_id'] ?? row.agent_id ?? ''),
    tier: String(s['tier'] ?? row.tier_proven),
    repid_score: Number(s['repid_score']),
    threshold: Number(s['threshold']),
  };
}

async function count(db: SupabaseClient, col: string, val: string): Promise<number | null> {
  const { count: n, error } = await db.from('repid_zkp_proofs').select('id', { count: 'exact', head: true }).eq(col, val);
  return error ? null : n;
}

interface AnchorInfo { anchor: Verdict; anchor_detail: string; included: Verdict; included_detail: string; ids: Set<number>; onchainRoot?: string; commitments?: string[]; scheme?: string }

async function checkAnchor(db: SupabaseClient, eas: Contract, uid: string): Promise<AnchorInfo> {
  const nc = (d: string): AnchorInfo => ({ anchor: 'NOT_CHECKED', anchor_detail: d, included: 'NOT_CHECKED', included_detail: d, ids: new Set() });
  let att: { uid: string; schema: string; time: bigint; expirationTime: bigint; revocationTime: bigint; attester: string; data: string };
  try { att = await eas.getFunction('getAttestation').staticCall(uid); } catch (e) { return nc(`eth_call failed: ${(e as Error).message.slice(0, 120)}`); }
  if (att.uid.toLowerCase() !== uid.toLowerCase()) {
    return { anchor: 'FAILED', anchor_detail: 'getAttestation returned the empty struct: no such attestation', included: 'FAILED', included_detail: 'no on-chain payload', ids: new Set() };
  }
  const revoked = att.revocationTime !== 0n;
  const expired = att.expirationTime !== 0n && att.expirationTime < BigInt(Math.floor(Date.now() / 1000));
  const when = new Date(Number(att.time) * 1000).toISOString();
  const anchor: Verdict = revoked || expired ? 'FAILED' : 'VERIFIED';
  const anchor_detail = `${revoked ? 'REVOKED' : expired ? 'EXPIRED' : 'exists, not revoked, not expired'}; schema ${att.schema.slice(0, 10)}…; attester ${att.attester.slice(0, 10)}…; time ${when}`;

  let onchainRoot: string;
  try { onchainRoot = String(AbiCoder.defaultAbiCoder().decode(PAYLOAD, att.data)[2]).toLowerCase(); } catch (e) {
    return { anchor, anchor_detail, included: 'FAILED', included_detail: `payload does not decode as PROOF_SCHEMA_DEF: ${(e as Error).message.slice(0, 80)}`, ids: new Set() };
  }
  // The anchor worker's selectBatch order: created_at ASC, id ASC.
  const rows: { id: number; zk_commitment: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('repid_zkp_proofs').select('id, zk_commitment').eq('eas_attestation_uid', uid)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
    if (error) return { anchor, anchor_detail, included: 'NOT_CHECKED', included_detail: `DB read failed: ${error.message}`, ids: new Set() };
    rows.push(...(data as typeof rows));
    if (!data || data.length < 1000) break;
  }
  if (!rows.length) return { anchor, anchor_detail, included: 'FAILED', included_detail: 'the DB attributes no rows to this uid', ids: new Set() };
  // The batch row names the hash scheme. A failed lookup is NOT_CHECKED; a missing row (the one batch
  // whose audit insert was lost, BEAT26) falls back to the worker's default and says so.
  const { data: batch, error: batchErr } = await db.from('eas_anchor_batches').select('hash_scheme').eq('eas_uid', uid).limit(1);
  if (batchErr) return { anchor, anchor_detail, included: 'NOT_CHECKED', included_detail: `hash_scheme lookup failed: ${batchErr.message}`, ids: new Set() };
  const named = (batch?.[0] as { hash_scheme?: string } | undefined)?.hash_scheme;
  const scheme = named || 'keccak256';
  const commitments = rows.map((r) => r.zk_commitment);
  const { root } = rootFromCommitments(commitments, scheme);
  const ok = root.toLowerCase() === onchainRoot;
  return {
    anchor, anchor_detail, ids: new Set(rows.map((r) => r.id)), onchainRoot, commitments, scheme,
    included: ok ? 'VERIFIED' : 'FAILED',
    included_detail: `${rows.length} leaves, ${scheme}${named ? '' : ' (no batch row: default)'}: recomputed root ${ok ? '==' : '!='} on-chain root ${onchainRoot.slice(0, 12)}…`,
  };
}

async function main(): Promise<number> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log('NOT_CHECKED: set SUPABASE_URL and SUPABASE_SECRET_KEY.'); return 2; }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const eas = new Contract(EAS, EAS_ABI, new JsonRpcProvider(arg('rpc') ?? 'https://sepolia.base.org', 84532, { staticNetwork: true }));
  const real = () => db.from('repid_zkp_proofs').select('id').eq('scheme', 'plonky3_range_check').eq('is_real', true);

  // Positive control: the CI synthetic fixture must verify, or this verifier cannot say "yes".
  const fixDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'zkp');
  const fix = JSON.parse(readFileSync(join(fixDir, 'leaf-rangecheck.synthetic.json'), 'utf8'));
  const pc = verifyRangeCheck(readFileSync(join(fixDir, fix.proof_file)).toString('base64'), fix.statement);
  console.log(`positive control (synthetic fixture): ${pc.verified ? 'VERIFIED' : 'FAILED'} verifier ${pc.verifier_version}${pc.error ? ` (${pc.error})` : ''}`);
  if (!pc.verified) { console.log('NOT_CHECKED: the verifier does not accept a known-good proof, so its rejections mean nothing.'); return 2; }

  const { data: top, error: topErr } = await real().order('id', { ascending: false }).limit(1);
  if (topErr) { console.log(`NOT_CHECKED: DB read failed: ${topErr.message}`); return 2; }
  const maxId = Number(arg('max-id') ?? (top?.[0] as { id: number } | undefined)?.id ?? 0);

  // Population (ids + statement shape only) up to the cutoff.
  const pop: { id: number; shape: string; uid: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('repid_zkp_proofs').select('id, statement, eas_attestation_uid').eq('scheme', 'plonky3_range_check').eq('is_real', true)
      .lte('id', maxId).order('id').range(from, from + 999);
    if (error) { console.log(`NOT_CHECKED: DB read failed: ${error.message}`); return 2; }
    for (const r of data as { id: number; statement: unknown; eas_attestation_uid: string | null }[]) pop.push({ id: r.id, shape: shapeOf(r.statement), uid: r.eas_attestation_uid });
    if (data.length < 1000) break;
  }
  const strata = new Map<string, number>();
  for (const p of pop) strata.set(p.shape, (strata.get(p.shape) ?? 0) + 1);
  const shapeById = new Map(pop.map((p) => [p.id, p.shape]));

  const seed = arg('seed');
  const idsArg = arg('ids');
  const k = Number(arg('per-stratum') ?? 10);
  let picks: { id: number; weight: number | null }[];
  if (idsArg) {
    const raw = existsSync(idsArg) ? readFileSync(idsArg, 'utf8') : idsArg;
    picks = raw.split(/[\s,]+/).filter(Boolean).map((t) => { const [i, w] = t.split(':'); return { id: Number(i), weight: w ? Number(w) : null }; });
  } else if (seed && Number.isInteger(k) && k > 0) {
    picks = drawSample(pop, seed, k).map((id) => ({ id, weight: null }));
  } else { console.log('usage: --seed <s> [--per-stratum <positive integer>] | --ids <file|list>   [--max-id n] [--out path]'); return 2; }

  console.log(`population: is_real plonky3_range_check, id <= ${maxId}: ${pop.length} rows in ${strata.size} statement shapes`);
  for (const [s, n] of strata) console.log(`  ${n.toString().padStart(6)}  {${s}}`);
  if (seed && !idsArg) {
    console.log(`sample: seed "${seed}", ${k} per shape → ${picks.length} rows. Redraw in SQL:`);
    console.log(`  ${redrawSql(seed, maxId, k)}`);
  }

  const anchors = new Map<string, AnchorInfo>();
  const results: Record<string, unknown>[] = [];
  let firstVerified: { bytes: string; st: ReturnType<typeof canonical> } | null = null;
  let firstAnchor: AnchorInfo | null = null;

  for (const pick of picks) {
    const { data, error } = await db.from('repid_zkp_proofs')
      .select('id, agent_id, tier_proven, statement, proof_bytes, zk_commitment, eas_attestation_uid, job_id, event_id, created_at, scheme, is_real')
      .eq('id', pick.id).maybeSingle();
    if (error || !data) {
      const why = error?.message ?? 'row not found';
      results.push({ id: pick.id, weight: pick.weight, ...Object.fromEntries(['verify', 'unique', 'event', 'anchor', 'included', 'binding'].flatMap((l) => [[l, 'NOT_CHECKED'], [`${l}_detail`, why]])) });
      continue;
    }
    const row = data as Row & { scheme: string; is_real: boolean };
    const st = canonical(row);
    const r: Record<string, unknown> = {
      id: row.id, weight: pick.weight, shape: shapeById.get(row.id) ?? shapeOf(row.statement), created_at: row.created_at,
      threshold: st.threshold, repid_score: st.repid_score, tier: st.tier,
    };

    // verify
    if (row.scheme !== 'plonky3_range_check' || !row.is_real || !row.proof_bytes) {
      r['verify'] = 'NOT_CHECKED'; r['verify_detail'] = 'not a real plonky3_range_check row with proof bytes';
    } else {
      const v = verifyRangeCheck(row.proof_bytes, st);
      const asIs = verifyRangeCheck(row.proof_bytes, (row.statement ?? {}) as Record<string, unknown>);
      r['verify'] = v.verified ? 'VERIFIED' : 'FAILED';
      r['verify_detail'] = v.verified ? `accepted, ${v.proof_size_bytes} bytes` : `rejected: ${v.error}`;
      r['verify_stored_statement_as_is'] = asIs.verified ? 'VERIFIED' : `FAILED (${(asIs.error ?? '').slice(0, 60)})`;
      r['proves'] = v.verified ? `${st.threshold} < ${st.repid_score} <= ${st.threshold + 65536}; ${PROVES}` : 'nothing (did not verify)';
      if (v.verified && !firstVerified) firstVerified = { bytes: row.proof_bytes, st };
    }

    // unique
    const nId = await count(db, 'id', String(row.id));
    const nC = row.zk_commitment ? await count(db, 'zk_commitment', row.zk_commitment) : null;
    const nJ = row.job_id ? await count(db, 'job_id', row.job_id) : null;
    if (nId === null || (row.zk_commitment && nC === null) || (row.job_id && nJ === null)) { r['unique'] = 'NOT_CHECKED'; r['unique_detail'] = 'count query failed'; }
    else {
      const ok = nId === 1 && nC === 1 && (row.job_id ? nJ === 1 : true);
      r['unique'] = ok ? 'VERIFIED' : 'FAILED';
      r['unique_detail'] = `id×${nId}, commitment×${nC ?? 'none'}, job_id×${row.job_id ? nJ : 'none (NULL)'}${pick.weight ? `; these proof bytes+statement are shared by ${pick.weight} rows` : ''}`;
    }

    // event: the proven score must be what the ledger recorded as this agent's score at proof time,
    // i.e. the repid_after of its latest repid_score_events row at or before created_at. The proof
    // states the live score, so the job_id-linked event can be older than the latest one.
    if (!row.agent_id) { r['event'] = 'FAILED'; r['event_detail'] = 'row has no agent_id'; }
    else {
      const { data: last, error: lastErr } = await db.from('repid_score_events').select('repid_after, created_at').eq('agent_id', row.agent_id)
        .lte('created_at', row.created_at).order('created_at', { ascending: false }).limit(1);
      if (lastErr) { r['event'] = 'NOT_CHECKED'; r['event_detail'] = `query failed: ${lastErr.message}`; }
      else if (!last?.length) { r['event'] = 'FAILED'; r['event_detail'] = 'no score event for this agent at or before the proof'; }
      else {
        // Every event at that same instant: if they disagree, the ledger's score at proof time is ambiguous.
        const at = (last[0] as { created_at: string }).created_at;
        const { data: tied, error: tieErr } = await db.from('repid_score_events').select('repid_after').eq('agent_id', row.agent_id).eq('created_at', at);
        const values = [...new Set(((tied ?? last) as { repid_after: number | null }[]).map((e) => e.repid_after))];
        if (tieErr) { r['event'] = 'NOT_CHECKED'; r['event_detail'] = `tie query failed: ${tieErr.message}`; }
        else if (values.length > 1) { r['event'] = 'NOT_CHECKED'; r['event_detail'] = `${tied!.length} score events share the latest instant and end at ${values.join('/')}; proven ${st.repid_score}`; }
        else {
          r['event'] = values[0] === st.repid_score ? 'VERIFIED' : 'FAILED';
          r['event_detail'] = `latest score event at proof time ended at ${values[0]}; proven ${st.repid_score}`;
        }
      }
    }
    if (row.job_id) {
      const { data: ev, error: evErr } = await db.from('repid_score_events').select('repid_after').eq('zk_proof_id', row.job_id);
      r['event_link'] = evErr ? `NOT_CHECKED (${evErr.message})` : !ev?.length ? 'job_id set, no score event carries it'
        : `job_id → ${ev.length} event(s), repid_after ${(ev as { repid_after: number | null }[]).map((e) => e.repid_after).join('/')}`;
    } else r['event_link'] = `none recorded: event_id ${row.event_id ? 'set' : 'NULL'}, job_id NULL`;

    // anchor + included
    if (!row.eas_attestation_uid) { r['anchor'] = 'FAILED'; r['anchor_detail'] = 'no eas_attestation_uid'; r['included'] = 'FAILED'; r['included_detail'] = 'no anchor'; }
    else {
      let a = anchors.get(row.eas_attestation_uid);
      if (!a) { a = await checkAnchor(db, eas, row.eas_attestation_uid); anchors.set(row.eas_attestation_uid, a); }
      r['anchor'] = a.anchor; r['anchor_detail'] = a.anchor_detail;
      r['included'] = a.included === 'VERIFIED' && !a.ids.has(row.id) ? 'FAILED' : a.included;
      r['included_detail'] = a.included_detail + (a.ids.has(row.id) ? '; this row is a leaf' : '; this row is NOT among the leaves');
      if (a.included === 'VERIFIED' && !firstAnchor) firstAnchor = a;
    }

    // binding
    const extra = Object.keys({ ...(row.statement ?? {}), ...row }).filter((x) => /nonce|prover_?commitment/i.test(x));
    r['binding'] = 'NOT_CHECKED';
    r['binding_detail'] = extra.length ? `fields ${extra.join(',')} exist but recomputing the @1 leaf is not implemented here` : BINDING_REASON;
    results.push(r);
    process.stdout.write('.');
  }
  console.log('');

  // Negative controls: each must come back the other way, or the leg above measured nothing.
  const controls: Record<string, string> = { positive_fixture: pc.verified ? 'VERIFIED (expected)' : 'FAILED' };
  let controlsOk = true;
  const expect = (name: string, got: boolean, want: boolean, detail: string) => {
    controls[name] = `${got === want ? 'OK' : 'BROKEN'}: ${detail}`;
    if (got !== want) controlsOk = false;
  };
  if (firstVerified) {
    // One flipped byte at each of 16 evenly spaced offsets: every one must be rejected. Counting which
    // fail at deserialisation vs inside the STARK check shows the verifier, not only the parser, says no.
    const len = Buffer.from(firstVerified.bytes, 'base64').length;
    const flips = Array.from({ length: 16 }, (_, j) => verifyRangeCheck(flipByte(firstVerified!.bytes, Math.floor(((j + 0.5) * len) / 16)), firstVerified!.st));
    const accepted = flips.filter((f) => f.verified).length;
    const deser = flips.filter((f) => !f.verified && /deser/i.test(f.error ?? '')).length;
    const kinds = [...new Set(flips.filter((f) => !f.verified && !/deser/i.test(f.error ?? '')).map((f) => (f.error ?? '').slice(0, 40)))];
    // OK needs every flip rejected AND at least one rejected by the STARK check, not the parser: a
    // parser that refuses every tampered byte would otherwise pass this without the verifier running.
    const byVerify = 16 - accepted - deser;
    expect('flip_one_proof_byte', accepted > 0 || byVerify === 0, false, `16 single-byte flips of a real ${len}-byte proof: ${16 - accepted} rejected (${deser} at deserialisation, ${byVerify} by verification${kinds.length ? `: ${kinds.join(' | ')}` : ''}), ${accepted} accepted`);
    const s = verifyRangeCheck(firstVerified.bytes, { ...firstVerified.st, repid_score: firstVerified.st.repid_score + 1 });
    expect('score_plus_one', s.verified, false, `same proof, claimed score +1 → ${s.verified ? 'ACCEPTED' : 'rejected'}`);
    const a = verifyRangeCheck(firstVerified.bytes, { ...firstVerified.st, agent_id: '00000000-0000-4000-8000-0000000000cc' });
    expect('substituted_agent_id', a.verified, false, `same proof, ONE fabricated agent_id → ${a.verified ? 'ACCEPTED' : 'rejected'} (catches an unbound agent_id; its strength is agent_binding_rate)`);
    const t = verifyRangeCheck(firstVerified.bytes, { ...firstVerified.st, tier: firstVerified.st.tier === 'VETERAN' ? 'PROBATIONARY' : 'VETERAN' });
    expect('tier_swap_is_not_bound', t.verified, true, `same proof, another tier → ${t.verified ? 'accepted: tier is NOT bound (documented)' : 'rejected'}`);
    // A measurement, not a pass/fail control: how often the same bytes verify under a FOREIGN agent id.
    // Seeded ids (sha256("p15-bind:<i>") shaped as a v4 uuid) so the count reproduces exactly.
    const bindN = Number(arg('bind-n') ?? 256);
    let foreign = 0;
    for (let i = 0; i < bindN; i++) {
      const x = createHash('sha256').update(`p15-bind:${i}`).digest('hex');
      const id = `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
      if (verifyRangeCheck(firstVerified.bytes, { ...firstVerified.st, agent_id: id }).verified) foreign++;
    }
    const [blo, bhi] = wilson(foreign, bindN);
    controls['agent_binding_rate'] = `MEASURED: ${foreign}/${bindN} foreign agent ids verify the same proof bytes (95% Wilson ${blo.toFixed(4)}–${bhi.toFixed(4)}; an 8-bit grind predicts 1/256 = 0.0039)`;
  } else {
    for (const n of ['flip_one_proof_byte', 'score_plus_one', 'substituted_agent_id', 'tier_swap_is_not_bound', 'agent_binding_rate']) {
      controls[n] = 'NOT_CHECKED: no sampled proof verified, so there was no real proof to tamper with';
    }
  }
  try {
    // "Absent" means the all-zero uid. Any other reply, including a different non-zero uid, is BROKEN.
    const z = String((await eas.getFunction('getAttestation').staticCall(FAKE_UID)).uid).toLowerCase();
    expect('fabricated_uid_absent', z !== ZERO_UID, false, `getAttestation(0xdead…beef) → ${z === ZERO_UID ? 'empty struct' : z}`);
  } catch (e) { controls['fabricated_uid_absent'] = `NOT_CHECKED: ${(e as Error).message.slice(0, 80)}`; }
  if (firstAnchor?.commitments?.length && firstAnchor.onchainRoot) {
    // Alter the first leaf, then the last: a root function that skipped either end would leave one green.
    const ends = [...new Set([0, firstAnchor.commitments.length - 1])];
    const still = ends.filter((i) => {
      const bent = [...firstAnchor!.commitments!]; bent[i] = bent[i]!.slice(0, -1) + (bent[i]!.endsWith('0') ? '1' : '0');
      return rootFromCommitments(bent, firstAnchor!.scheme).root.toLowerCase() === firstAnchor!.onchainRoot;
    });
    expect('altered_leaf_changes_root', still.length > 0, false, `leaf ${ends.join(' and leaf ')} each altered by one hex digit → root ${still.length ? `STILL MATCHES for leaf ${still.join(',')}` : 'no longer matches'}`);
  } else controls['altered_leaf_changes_root'] = 'NOT_CHECKED: no anchor root was reproduced';

  // Summary, with its ruler.
  const legs = ['verify', 'unique', 'event', 'anchor', 'included', 'binding'];
  const weighted = picks.every((p) => p.weight !== null);
  const totalW = weighted ? picks.reduce((a, p) => a + (p.weight ?? 0), 0) : 0;
  const summary: Record<string, unknown> = {};
  console.log(`\nRULER: ${idsArg ? `explicit id list (${picks.length} ids${weighted ? `, weights sum ${totalW}` : ''})` : `seed "${seed}", ${k} per shape`}; population ${pop.length} rows, id <= ${maxId}; verifier ${pc.verifier_version}; ${new Date().toISOString()}`);
  for (const leg of legs) {
    const c = { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 } as Record<Verdict, number>;
    const w = { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 } as Record<Verdict, number>;
    for (const r of results) {
      const v = r[leg] as Verdict | undefined;
      if (!v) continue;
      c[v]++; w[v] += Number(r['weight'] ?? 0);
    }
    const n = c.VERIFIED + c.FAILED;
    const [lo, hi] = wilson(c.VERIFIED, n);
    // Weights (rows sharing identical proof bytes + bound statement) carry over ONLY to `verify`, the
    // one leg that is a pure function of those inputs. Every other leg depends on the row itself.
    const showW = weighted && leg === 'verify';
    summary[leg] = { ...c, ...(showW ? { rows_weighted: w } : {}), wilson95_verified_of_checked: n ? [+lo.toFixed(3), +hi.toFixed(3)] : null };
    console.log(`  ${leg.padEnd(9)} VERIFIED ${c.VERIFIED}  FAILED ${c.FAILED}  NOT_CHECKED ${c.NOT_CHECKED}` +
      (showW ? `   rows covered: ${w.VERIFIED}/${w.FAILED}/${w.NOT_CHECKED}` : '') + (n ? `   95% Wilson ${lo.toFixed(3)}–${hi.toFixed(3)}` : ''));
  }
  for (const [name, v] of Object.entries(controls)) console.log(`  control ${name}: ${v}`);

  // --all-anchors: every distinct uid in the population, so `anchor` and `included` become a count
  // over all rows rather than a sample estimate. A row with no uid counts as FAILED for both.
  let anchorCensus: Record<string, unknown> | null = null;
  if (process.argv.includes('--all-anchors')) {
    const rowsPerUid = new Map<string | null, number>();
    for (const p of pop) rowsPerUid.set(p.uid, (rowsPerUid.get(p.uid) ?? 0) + 1);
    const tally = { anchor: { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 }, included: { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 } } as Record<'anchor' | 'included', Record<Verdict, number>>;
    const rows = { anchor: { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 }, included: { VERIFIED: 0, FAILED: 0, NOT_CHECKED: 0 } } as Record<'anchor' | 'included', Record<Verdict, number>>;
    const notes: string[] = [];
    for (const [uid, n] of rowsPerUid) {
      const a: AnchorInfo = uid ? anchors.get(uid) ?? (await checkAnchor(db, eas, uid)) : { anchor: 'FAILED', anchor_detail: 'no uid', included: 'FAILED', included_detail: 'no uid', ids: new Set() };
      if (uid) anchors.set(uid, a);
      // Leaves the DB attributes to this uid but the population cutoff excludes would make n < ids.size; report it.
      if (uid && a.ids.size !== n) notes.push(`${uid.slice(0, 10)}…: ${a.ids.size} leaves vs ${n} population rows`);
      for (const leg of ['anchor', 'included'] as const) { tally[leg][a[leg]]++; rows[leg][a[leg]] += n; }
      if (a.included !== 'VERIFIED' || a.anchor !== 'VERIFIED') notes.push(`${uid ? uid.slice(0, 10) + '…' : '(no uid)'} ${a.anchor}/${a.included}: ${a.included_detail}`);
      process.stdout.write('.');
    }
    console.log('');
    anchorCensus = { uids: rowsPerUid.size, uid_verdicts: tally, row_verdicts: rows, notes };
    for (const leg of ['anchor', 'included'] as const) {
      console.log(`  ALL-ANCHORS ${leg.padEnd(8)} uids ${tally[leg].VERIFIED}/${tally[leg].FAILED}/${tally[leg].NOT_CHECKED}   rows ${rows[leg].VERIFIED}/${rows[leg].FAILED}/${rows[leg].NOT_CHECKED}  (VERIFIED/FAILED/NOT_CHECKED, ${rowsPerUid.size} uids, ${pop.length} rows)`);
    }
    for (const n of notes.slice(0, 20)) console.log(`    note ${n}`);
  }

  const out = arg('out');
  if (out) {
    writeFileSync(out, JSON.stringify({ ruler: { mode: idsArg ? 'ids' : 'seed', seed: seed ?? null, per_stratum: idsArg ? null : k, max_id: maxId, population: pop.length, strata: Object.fromEntries(strata), verifier_version: pc.verifier_version, run_at: new Date().toISOString() }, controls, summary, anchor_census: anchorCensus, rows: results }, null, 2));
    console.log(`wrote ${out}`);
  }
  const anyFailed = results.some((r) => legs.some((l) => r[l] === 'FAILED'))
    || (anchorCensus !== null && Object.values(anchorCensus['uid_verdicts'] as Record<string, Record<Verdict, number>>).some((t) => t.FAILED > 0));
  // A leg or control that could not run is not a pass. binding is NOT_CHECKED by construction (@1), so it
  // alone does not count; any other NOT_CHECKED makes the run NOT_CHECKED rather than green.
  const anyNotChecked = results.some((r) => legs.some((l) => l !== 'binding' && r[l] === 'NOT_CHECKED'))
    || Object.values(controls).some((v) => v.startsWith('NOT_CHECKED'))
    || (anchorCensus !== null && Object.values(anchorCensus['uid_verdicts'] as Record<string, Record<Verdict, number>>).some((t) => t.NOT_CHECKED > 0));
  return !controlsOk || anyFailed ? 1 : anyNotChecked ? 2 : 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
