/**
 * immune/execution-origin.ts — authenticate WHO produced the evidence and under WHAT authorization (P0, D-130).
 *
 * THE GAP THIS CLOSES. A combined receipt's harness/promoter keys are EPHEMERAL per mission and self-asserted,
 * and its passport is self-signed — so signature-verified + config-matched proves only that SOMEONE ran SOMETHING
 * shaped right, never that the APPROVED execution happened. A hostile PR job can mint its own keys, fabricate a
 * config-matching passport, and correctly self-sign the whole thing. If the protected engine attested THAT,
 * untrusted evidence would launder into trusted reputation (Grok + Chat, independently).
 *
 * THE FIX. Authenticity rests on roots the Maker DOES NOT control:
 *   - a MISSION ADMISSION, signed by the trusted runner / admission service (NOT the Maker), binding the approved
 *     workflow identity, the exact reviewed commit, the mission, the artifact digest, a one-time nonce, an expiry;
 *   - an OWNER GRANT, signed by the OWNER, binding the authorized policy scope, capabilities and validity window.
 * verifyExecutionOrigin checks BOTH under PINNED external roots and cross-binds them to the mission + artifact. A
 * forger who holds the receipt's ephemeral keys still cannot produce a valid admission or grant, so origin is NOT
 * authentic and the receipt can never be authoritative — the P0 acceptance test.
 *
 * INERT + fail-closed. No external root is shipped (admissionRoots/ownerRoots default empty ⇒ nothing authentic).
 * The GitHub pilot binds the admission to GitHub OIDC workload identity + artifact attestations for an allowlisted
 * protected workflow; that is the ENGINE's wiring and does not change this primitive. CAVEAT (recorded on purpose):
 * provenance proves ORIGIN + AUTHORIZATION, never that the Maker's ANSWER is correct — correctness stays the
 * evaluator's job, settlement the engine's. An attacker-controlled PR workflow cannot declare itself trusted here.
 */
import { createPublicKey, sign, type KeyObject } from 'node:crypto';
import { KERNEL_RECEIPT_SIGNATURE_DOMAIN, signerFromPublicKey, verifyEd25519 } from '../kernel/receipt-signing';
import type { ReceiptSigner } from '../kernel/types';
import { canonicalJson } from '../services/owner-authorization';

export const MISSION_ADMISSION_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.mission-admission.v1\n`;
export const OWNER_GRANT_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.owner-grant.v1\n`;

/** Signed by the TRUSTED RUNNER / admission service — the Maker cannot forge it (it lacks the key). */
export interface MissionAdmissionPayload {
  mission_id: string;
  /** the exact reviewed commit the approved workflow ran. */
  source_commit: string;
  /** the approved workflow / runner identity (e.g. a GitHub OIDC job_workflow_ref). */
  workflow_id: string;
  /** sha256 of the admitted artifact — must equal the mission's bound artifact digest. */
  artifact_digest: string;
  /** the owner grant this admission was issued under. */
  owner_grant_id: string;
  /** one-time nonce — a replayed admission is refused. */
  nonce: string;
  issued_at: number;
  expires_at: number;
}

/** Signed by the OWNER: the exact authorized scope, not merely that some valid policy existed (D-130 P0-c). */
export interface OwnerGrantPayload {
  grant_id: string;
  owner_principal: string;
  mission_id: string;
  approved_capabilities: string[];
  policy_version: string;
  /** the mission scope this grant covers: '*' or a specific mission/experiment id. */
  scope: string;
  not_before: number;
  not_after: number;
}

export interface Signed<P> {
  payload: P;
  signer: ReceiptSigner;
  /** Ed25519 over `<domain> + canonicalJson(payload)`, 0x + 128 hex. */
  signature: string;
}
export type SignedMissionAdmission = Signed<MissionAdmissionPayload>;
export type SignedOwnerGrant = Signed<OwnerGrantPayload>;

/** A pinned EXTERNAL authority (admission service / owner), by Ed25519 fingerprint. */
export interface OriginRoot {
  fingerprint: string;
}

/** What the mission being authorized binds to — the engine extracts these from the evidence it is deciding on. */
export interface OriginBinding {
  mission_id: string;
  artifact_digest: string;
  experiment_id?: string;
}

export interface OriginVerification {
  /** admission AND owner grant both authenticated under external pinned roots AND bound to this mission. */
  authentic: boolean;
  reasons: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

function pubKeyHex(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return `0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`;
}

function signUnder<P>(domain: string, payload: P, key: KeyObject): Signed<P> {
  const signer = signerFromPublicKey(pubKeyHex(key));
  if (signer === null) throw new Error('[immune] execution-origin: signing key is not an Ed25519 key');
  const signature = `0x${sign(null, Buffer.from(domain + canonicalJson(payload), 'utf8'), key).toString('hex')}`;
  return { payload, signer, signature };
}
/** Sign a mission admission with the trusted-runner/admission key (NEVER the Maker's). */
export const signMissionAdmission = (payload: MissionAdmissionPayload, key: KeyObject): SignedMissionAdmission => signUnder(MISSION_ADMISSION_DOMAIN, payload, key);
/** Sign an owner grant with the OWNER's key. */
export const signOwnerGrant = (payload: OwnerGrantPayload, key: KeyObject): SignedOwnerGrant => signUnder(OWNER_GRANT_DOMAIN, payload, key);

/** Verify a signed structure under its domain + one pinned external root set. Returns the payload only if AUTHENTIC. */
function verifySigned<P>(s: unknown, domain: string, roots: readonly OriginRoot[], kind: string, refuse: (r: string) => void): P | null {
  if (!isObj(s)) {
    refuse(`${kind}_malformed`);
    return null;
  }
  const signerRaw = s['signer'];
  const signature = s['signature'];
  const payload = s['payload'];
  if (!isObj(signerRaw) || typeof signature !== 'string' || !isObj(payload)) {
    refuse(`${kind}_malformed`);
    return null;
  }
  const signer = signerRaw as unknown as ReceiptSigner;
  const message = domain + canonicalJson(payload);
  if (signerFromPublicKey(signer.public_key)?.fingerprint !== signer.fingerprint.toLowerCase() || !verifyEd25519(signer.public_key, message, signature)) {
    refuse(`${kind}_unauthenticated`);
    return null;
  }
  if (!roots.some((t) => t.fingerprint.toLowerCase() === signer.fingerprint.toLowerCase())) {
    refuse(`${kind}_untrusted_signer`); // valid signature, but not from a PINNED external authority — the forgery case
    return null;
  }
  return payload as P;
}

/**
 * Authenticate the ORIGIN of a mission against roots the Maker does not control. `authentic` only when BOTH the
 * admission (trusted runner) and the owner grant verify under their pinned external roots, the nonce is unseen and
 * unexpired, and admission/grant both bind the SAME mission + artifact the engine is deciding on. Never throws.
 */
export function verifyExecutionOrigin(
  input: { admission: unknown; ownerGrant: unknown; binding: OriginBinding },
  opts: { admissionRoots?: readonly OriginRoot[]; ownerRoots?: readonly OriginRoot[]; seenNonces?: ReadonlySet<string>; now?: number } = {},
): OriginVerification {
  const reasons: string[] = [];
  const refuse = (r: string): void => {
    reasons.push(r);
  };
  const now = opts.now ?? Date.now();
  const admissionRoots = opts.admissionRoots ?? [];
  const ownerRoots = opts.ownerRoots ?? [];
  const { mission_id, artifact_digest, experiment_id } = input.binding;

  // fail-closed: no external root pinned ⇒ nothing can be authenticated (the inert default).
  if (admissionRoots.length === 0) refuse('no_admission_root');
  if (ownerRoots.length === 0) refuse('no_owner_root');

  const adm = verifySigned<MissionAdmissionPayload>(input.admission, MISSION_ADMISSION_DOMAIN, admissionRoots, 'admission', refuse);
  const grant = verifySigned<OwnerGrantPayload>(input.ownerGrant, OWNER_GRANT_DOMAIN, ownerRoots, 'owner_grant', refuse);

  if (adm) {
    if (now < adm.issued_at || now > adm.expires_at) refuse('admission_expired');
    if (opts.seenNonces?.has(adm.nonce)) refuse('admission_replayed');
    if (adm.mission_id !== mission_id) refuse('admission_mission_mismatch');
    if (adm.artifact_digest.toLowerCase() !== String(artifact_digest).toLowerCase()) refuse('admission_artifact_mismatch');
  }
  if (grant) {
    if (now < grant.not_before || now > grant.not_after) refuse('owner_grant_expired');
    if (grant.mission_id !== mission_id) refuse('owner_grant_mission_mismatch');
    if (!(grant.scope === '*' || grant.scope === mission_id || (experiment_id !== undefined && grant.scope === experiment_id))) refuse('owner_grant_scope_mismatch');
  }
  if (adm && grant && adm.owner_grant_id !== grant.grant_id) refuse('admission_grant_mismatch');
  if (adm && grant && adm.mission_id !== grant.mission_id) refuse('admission_grant_mission_mismatch');

  return { authentic: reasons.length === 0, reasons };
}
