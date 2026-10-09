/**
 * signed-job.ts — the TrustKeys "reference tier" signed-job VERIFIER.
 *
 * THE DECISION THIS IMPLEMENTS (Sean, 2026-10-08 — "No key on our disk").
 * The owner's own box holds their key. They sign a job on that box. We VERIFY the
 * signature AND that the job lies inside a policy they already signed. We then store
 * ONLY receipt fields. This is NOT a broker and NOT custodial: we never receive,
 * store, or handle a private key or any decryptable secret.
 *
 * WHAT THIS IS NOT. There is no custodial store here, no decrypt-at-use, no key
 * column, no master key, no KMS, no ZK circuit, no Laya, no broker compiled into a
 * Witness. This module imports nothing from src/services/byok-custody.ts (PR #1270's
 * independent custodial approach) and never will — the two are deliberately separate.
 *
 * THREE OUTCOMES, NEVER TWO (LESSONS 5, CLAUDE_RULES). A refusal is a clean explicit
 * deny. A database or RepID read that ERRORS refuses with `not_checked` (503) — it is
 * never silently treated as a pass, and the raw error is logged server-side only and
 * never returned. "Not checked" is not "passed".
 *
 * FLAG: SIGNED_JOB_VERIFY_ENABLED (default OFF). Read per-request, so this surface
 * lands finished-and-inert per CLAUDE_RULES 23 — the route 404s until the operator
 * sets the flag AND applies the receipt migration. Nothing breaks before then.
 */
import { getAddress, id as keccakUtf8, isAddress } from 'ethers';
import { db } from '../db';
import { signReceipt } from './receipt-attestation';
import { verifyWalletMessage, type SignatureChain } from './wallet-signature';

/** Read per-request so the flag can be flipped (and tested) without a module reload. */
export function signedJobVerifyEnabled(): boolean {
  return process.env['SIGNED_JOB_VERIFY_ENABLED'] === 'true';
}

/** The one chain the whole product runs on. Policies/jobs are pinned to it. */
export const CHAIN_ID = 84532; // Base Sepolia

// --- RepID → spending ceiling, a documented MONOTONIC rule --------------------
//
// RepID may only TIGHTEN a policy, never loosen it: effective_cap = min(policy.cap,
// repidCeiling(owner)). The ceiling is derived from the owner's agent RepID through
// the EXISTING ownership read path (human_agent_bindings.human_wallet → repid_agents
// .current_repid), so no new identity notion is introduced.
//
// THE RULE: ceiling = clamp(current_repid, 10, 10000) * REPID_CEILING_UNIT_PER_POINT.
// Strictly monotonic in RepID — a higher score can only raise the ceiling. The unit is
// one token smallest-unit per RepID point (for a 6-decimal testnet token that is 1.00
// of ceiling per RepID point). An owner with NO bound agent resolves to the RepID
// FLOOR (10) — the most conservative ceiling, never an unbounded one — because an
// unknown reputation must tighten, not widen.
export const REPID_FLOOR = 10;
export const REPID_CAP = 10_000;
export const REPID_CEILING_UNIT_PER_POINT = 1_000_000n;

/** Pure, monotonic score → ceiling (token smallest-units). Exported for tests. */
export function repidCeilingFromScore(score: number): bigint {
  const s = Number.isFinite(score) ? Math.floor(score) : REPID_FLOOR;
  const clamped = Math.min(REPID_CAP, Math.max(REPID_FLOOR, s));
  return BigInt(clamped) * REPID_CEILING_UNIT_PER_POINT;
}

// --- One deterministic canonicalizer, used for signing-string recompute --------
//
// Stable key order at every depth, no whitespace. The owner signs canonicalJson(policy)
// and canonicalJson(job); the server recomputes the same string from the received object
// and recovers the signer. Because the `type` field ('trustkeys-policy' vs
// 'trustkeys-job') is INSIDE the signed bytes, a policy signature cannot be replayed as a
// job signature. Tampering with any field changes the canonical string and breaks recovery.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * The shared payee-hash primitive: keccak256 of the LOWERCASED payee address, hex.
 * The server never receives a raw payee address — the client computes this and sends
 * only the hash, so the receipt can record WHO was paid without storing the address.
 * This lives beside canonicalJson so there is a single source of truth for both.
 */
export function hashPayee(address: string): string {
  return keccakUtf8(address.toLowerCase());
}

// --- Types --------------------------------------------------------------------

export interface Policy {
  v: number;
  type: 'trustkeys-policy';
  owner: string;
  chain_id: number;
  cap: string;
  token: string;
  payee_hashes: string[];
  expiry: number;
  policy_nonce: string;
}

export interface Job {
  v: number;
  type: 'trustkeys-job';
  owner: string;
  chain_id: number;
  action: string;
  cap: string;
  payee_hash: string;
  expiry: number;
  nonce: string;
}

export interface VerifyInput {
  policy: unknown;
  policy_signature: unknown;
  job: unknown;
  job_signature: unknown;
}

export type VerifyOutcome =
  | {
      status: 200;
      body: {
        verified: true;
        receipt: {
          action: string;
          cap: string;
          payee_hash: string;
          chain_id: number;
          time: string;
          signature_status: 'verified';
        };
      };
    }
  | {
      status: 400 | 401 | 403 | 409 | 503;
      body: { verified: false; error: string; message: string };
    };

function deny(status: 400 | 401 | 403 | 409 | 503, error: string, message: string): VerifyOutcome {
  return { status, body: { verified: false, error, message } };
}

const HEX = /^0x[0-9a-fA-F]+$/;
const UNIX_INT = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n);
const INT_STRING = (s: unknown): s is string => typeof s === 'string' && /^[0-9]+$/.test(s);

/** Shape validation up front: a malformed body is a clean 400, never a crash or a fake pass. */
function shapeError(input: VerifyInput): string | null {
  const { policy, policy_signature, job, job_signature } = input;
  if (!policy || typeof policy !== 'object') return 'policy must be an object';
  if (!job || typeof job !== 'object') return 'job must be an object';
  if (typeof policy_signature !== 'string' || !HEX.test(policy_signature)) return 'policy_signature must be a hex string';
  if (typeof job_signature !== 'string' || !HEX.test(job_signature)) return 'job_signature must be a hex string';

  const p = policy as Record<string, unknown>;
  const j = job as Record<string, unknown>;
  if (p['type'] !== 'trustkeys-policy') return 'policy.type must be trustkeys-policy';
  if (j['type'] !== 'trustkeys-job') return 'job.type must be trustkeys-job';
  if (typeof p['owner'] !== 'string' || !isAddress(p['owner'])) return 'policy.owner must be an address';
  if (typeof j['owner'] !== 'string' || !isAddress(j['owner'])) return 'job.owner must be an address';
  if (p['chain_id'] !== CHAIN_ID || j['chain_id'] !== CHAIN_ID) return `chain_id must be ${CHAIN_ID}`;
  if (!INT_STRING(p['cap']) || !INT_STRING(j['cap'])) return 'cap must be an integer string (token smallest-unit)';
  if (!Array.isArray(p['payee_hashes']) || !p['payee_hashes'].every((h) => typeof h === 'string' && HEX.test(h)))
    return 'policy.payee_hashes must be an array of hex hashes';
  if (typeof j['payee_hash'] !== 'string' || !HEX.test(j['payee_hash'])) return 'job.payee_hash must be a hex hash';
  if (!UNIX_INT(p['expiry']) || !UNIX_INT(j['expiry'])) return 'expiry must be a unix-seconds integer';
  if (typeof p['policy_nonce'] !== 'string' || !HEX.test(p['policy_nonce'])) return 'policy.policy_nonce must be a hex string';
  if (typeof j['nonce'] !== 'string' || !HEX.test(j['nonce'])) return 'job.nonce must be a hex string';
  if (typeof j['action'] !== 'string' || !j['action']) return 'job.action is required';
  return null;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Resolve the owner's RepID ceiling through the existing ownership read path.
 * THROWS on a DB error so the caller can answer `not_checked` (503) — a read that
 * errored is never read as "no reputation". A clean "owner owns no agent" is the RepID
 * floor, not an error.
 */
export async function resolveOwnerRepidCeiling(ownerLower: string, chain?: SignatureChain): Promise<bigint> {
  void chain; // ownership is a DB fact, not a chain read; param kept for a symmetric signature
  const bindings = await db
    .from('human_agent_bindings')
    .select('agent_id')
    .ilike('human_wallet', ownerLower)
    .is('revoked_at', null);
  if (bindings.error) throw new Error(`binding read failed: ${bindings.error.message}`);
  const agentIds = ((bindings.data as Array<{ agent_id: string }> | null) ?? [])
    .map((b) => b.agent_id)
    .filter(Boolean);
  if (agentIds.length === 0) return repidCeilingFromScore(REPID_FLOOR);

  const agents = await db.from('repid_agents').select('id, current_repid').in('id', agentIds);
  if (agents.error) throw new Error(`repid read failed: ${agents.error.message}`);
  const scores = ((agents.data as Array<{ current_repid: number | null }> | null) ?? [])
    .map((a) => Number(a.current_repid ?? REPID_FLOOR))
    .filter((n) => Number.isFinite(n));
  // The owner's strongest established standing (best of their bound agents), floored.
  const best = scores.length ? Math.max(REPID_FLOOR, ...scores) : REPID_FLOOR;
  return repidCeilingFromScore(best);
}

/**
 * The verifier. Steps run in the pinned order, refusing on first failure:
 *   2. signatures recover each owner AND the two owners match   → signature_mismatch (401)
 *                                                                 (chain-unreachable → not_checked 503)
 *   3. both expiries in the future                              → expired (401)
 *   4. job.payee_hash ∈ policy.payee_hashes                     → payee_not_allowed (403)
 *   5. job.cap <= min(policy.cap, repidCeiling(owner))          → cap_exceeded (403)
 *                                          (RepID read error    → not_checked 503)
 *   6. receipt insert, UNIQUE(owner, nonce): duplicate          → replay (409)
 *                                          (other DB error      → not_checked 503)
 *   7. success                                                  → 200 { verified, receipt }
 *
 * `chain` is injectable only so a test can exercise the smart-wallet not_checked path; the
 * route omits it and the jest offline setup makes every unit address a plain wallet.
 */
export async function verifySignedJob(input: VerifyInput, chain?: SignatureChain): Promise<VerifyOutcome> {
  const shape = shapeError(input);
  if (shape) return deny(400, 'bad_request', shape);

  const policy = input.policy as Policy;
  const job = input.job as Job;
  const policySig = input.policy_signature as string;
  const jobSig = input.job_signature as string;

  // 2. Signatures. EIP-191 personal_sign over the canonical JSON of each object.
  const policyCheck = await verifyWalletMessage(policy.owner, canonicalJson(policy), policySig, chain);
  const jobCheck = await verifyWalletMessage(job.owner, canonicalJson(job), jobSig, chain);
  if ((!policyCheck.ok && policyCheck.reason === 'not_checked') || (!jobCheck.ok && jobCheck.reason === 'not_checked')) {
    // Could not look (chain unreachable for a smart wallet). Not a mismatch — honest 503.
    return deny(503, 'not_checked', 'Could not verify a signature against the chain; nothing was recorded.');
  }
  if (!policyCheck.ok || !jobCheck.ok || getAddress(policy.owner) !== getAddress(job.owner)) {
    return deny(401, 'signature_mismatch', 'A signature did not recover to its owner, or policy and job owners differ.');
  }

  // 3. Expiry — both must be in the future.
  const now = Math.floor(Date.now() / 1000);
  if (policy.expiry <= now || job.expiry <= now) {
    return deny(401, 'expired', 'The policy or the job has expired.');
  }

  // 4. Payee allow-list — the job's payee must be one the policy already named.
  if (!policy.payee_hashes.includes(job.payee_hash)) {
    return deny(403, 'payee_not_allowed', 'This payee is not in the signed policy.');
  }

  // 5. Cap — RepID may only TIGHTEN. Compared as integers (BigInt) so smallest-unit
  // caps above Number.MAX_SAFE_INTEGER do not silently lose precision.
  const ownerLower = policy.owner.toLowerCase();
  let repidCeiling: bigint;
  try {
    repidCeiling = await resolveOwnerRepidCeiling(ownerLower, chain);
  } catch (e) {
    // A DB error REFUSES. Logged server-side only; the raw error never leaves.
    console.error('[signed-job] repid ceiling read failed', e);
    return deny(503, 'not_checked', 'Could not read the owner RepID ceiling, so nothing was recorded.');
  }
  const effectiveCap = bigMin(BigInt(policy.cap), repidCeiling);
  if (BigInt(job.cap) > effectiveCap) {
    return deny(403, 'cap_exceeded', 'The job cap exceeds the effective cap (the smaller of the policy cap and the RepID ceiling).');
  }

  // 6. Replay guard IS the receipt insert. The DB UNIQUE(owner, nonce) is the authority;
  // a duplicate is the one legitimate "replay" and any other write error REFUSES.
  const insert = await db
    .from('signed_job_receipts')
    .insert({
      owner: ownerLower,
      nonce: job.nonce,
      action: job.action,
      cap: job.cap,
      payee_hash: job.payee_hash,
      chain_id: job.chain_id,
      signature_status: 'verified',
    })
    .select('created_at')
    .maybeSingle();

  if (insert.error) {
    const msg = String(insert.error.message ?? '');
    const code = String((insert.error as { code?: string }).code ?? '');
    if (/duplicate key|unique/i.test(msg) || code === '23505') {
      return deny(409, 'replay', 'This job nonce has already been verified for this owner.');
    }
    // Any other write failure is NOT_CHECKED, not a pass. Raw error server-side only.
    console.error('[signed-job] receipt insert failed', insert.error);
    return deny(503, 'not_checked', 'The receipt could not be recorded, so the job is not verified.');
  }

  const time = (insert.data as { created_at?: string } | null)?.created_at ?? new Date().toISOString();

  // 6b. ENGINE ATTESTATION (ADDITIONAL, never load-bearing). If RECEIPT_SIGNING_KEY is set, the engine
  // signs this receipt with its OWN key and stores the signature + signer so the row is independently
  // verifiable (recover the engine address from the bytes, confirm it equals the published signer) —
  // NOT just "our DB row". The receipt is signed over the EXACT stored `time`, so a later verify
  // recomputes identical bytes. When the key is unset the columns stay NULL and the receipt is
  // `attested:false`, never presented as attested. A signing OR store failure must NOT fail this
  // verify (the job IS verified; signature_status is unchanged) — it is logged server-side and the
  // columns are left NULL. The key never appears in a return, a log, or an error.
  try {
    const attestation = await signReceipt({
      owner: ownerLower,
      nonce: job.nonce,
      action: job.action,
      cap: job.cap,
      payee_hash: job.payee_hash,
      chain_id: job.chain_id,
      time,
    });
    if (attestation) {
      const stored = await db
        .from('signed_job_receipts')
        .update({ receipt_signature: attestation.signature, receipt_signer: attestation.signer })
        .eq('owner', ownerLower)
        .eq('nonce', job.nonce);
      if (stored.error) {
        // Could not persist the attestation. The job stays verified; the row is simply unsigned.
        console.error('[signed-job] receipt attestation store failed', stored.error);
      }
    }
  } catch (e) {
    // signReceipt never throws, but defend the verify regardless — an attestation problem is never a
    // verify failure. Fixed context only; no signature/key material is logged.
    console.error('[signed-job] receipt attestation step failed', e instanceof Error ? e.message : 'unknown');
  }

  // 7. Success. The response carries ONLY receipt fields — no key, prompt, sentence, or raw
  // payee address (none of which this verifier ever receives), only the payee HASH. The engine
  // attestation is stored on the row and surfaced by GET /receipts/:owner/:nonce, not here.
  return {
    status: 200,
    body: {
      verified: true,
      receipt: {
        action: job.action,
        cap: job.cap,
        payee_hash: job.payee_hash,
        chain_id: job.chain_id,
        time,
        signature_status: 'verified',
      },
    },
  };
}
