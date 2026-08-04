/**
 * holder-identity-binding.ts — make the holder-supplied nullifier path REAL: the
 * end-to-end wire from "a human holds a key" to "a row that fits
 * `human_agent_bindings`", with the engine holding no secret at the end of it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * `nullifier-identity.ts` (PR #325) built two secret sources and wired exactly one.
 * `engine-derived` runs today and is honest about being FULLY LINKABLE by whoever
 * holds `REPID_IDENTITY_MASTER_SECRET`. `identitySecretFromHolderSeed` — the only
 * path that removes the master from the picture — had no caller, no defined seed,
 * no statement of what a caller must send, and no shape that fits the table the
 * binding would land in. A function nobody can call is not a privacy property.
 *
 * This file supplies the missing half: the exact message a holder signs, the exact
 * derivation from that signature to a seed, the two postures a caller may use, the
 * guard that stops the obvious way of getting it wrong, and a row shape checked
 * against the live `human_agent_bindings` columns.
 *
 * IT WRITES NOTHING. There is no `db` import in this module and there is no chain
 * call. `human_agent_bindings` has ZERO rows [V SQL 2026-08-04] and its writer is
 * gated off by `HUMAN_AGENT_BIND_ENABLED`; this module produces the object such a
 * writer would insert, and validates it against the table's real constraints, so
 * that when a holder finally exists the shape is already right.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS FILE'S MAIN GUARD EXISTS FOR — read this before using the path
 * ════════════════════════════════════════════════════════════════════════════════
 * The obvious way to build a holder seed is: the holder already signs
 * `bindingMessage(...)` from `src/services/human-agent-binding.ts` to prove wallet
 * control, so derive the nullifier seed from THAT signature. It is one signature,
 * one prompt, no new UX.
 *
 * It is also a complete loss of the property. That signature is transmitted to the
 * engine and PERSISTED: `human_agent_bindings.binding_sig` is a real, populated
 * column [V information_schema 2026-08-04]. A seed derived from a persisted value
 * is a secret with a public pre-image. Anyone with SELECT on that table — not the
 * master-holder, not an operator with request logs, ANYONE with read access —
 * recomputes the seed, recomputes the identity secret, and recomputes every
 * nullifier that identity ever published, in every scope and every domain. That is
 * strictly WORSE than `engine-derived`, whose linkability at least requires a
 * Railway variable.
 *
 * So this module:
 *   - defines a SEPARATE message (`holderSeedMessage`) with its own tag, whose
 *     signature is never sent anywhere, and
 *   - refuses a seed that is derivable from a supplied `binding_sig`
 *     (`assertSeedIndependentOfBindingSignature`) — the mistake is blocked in code,
 *     not warned about in a comment.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT A CALLER MUST PROVIDE — two postures, and they are not equivalent
 * ════════════════════════════════════════════════════════════════════════════════
 * ── Posture A: `seed-to-engine` ─────────────────────────────────────────────────
 * The holder derives `seedHex` locally and sends it. The engine computes the
 * commitment and the nullifier.
 *   caller sends:  seedHex (32+ bytes)
 *   engine holds:  the seed and the derived secret, IN PROCESS MEMORY, for the
 *                  duration of the request
 *   engine persists: commitment + nullifier only — never the seed, never the felts
 *   removes:       the master-holder from the linking set
 *   does NOT remove: an operator who logs request bodies. JS cannot zero a bigint,
 *                  so "not persisted" is the ceiling, exactly as PR #325 said.
 *
 * ── Posture B: `client-computed` ────────────────────────────────────────────────
 * The holder derives the seed AND runs the commitment and the nullifier locally,
 * and sends only those two published values. The engine never sees any secret at
 * any point.
 *   caller sends:  identity_commitment + nullifier (both 0x+64 hex)
 *   engine holds:  nothing secret, ever
 *   engine persists: the same two published values
 *   removes:       the master-holder AND the request-logging operator
 *   does NOT remove: nothing about proof. See below — this is still not proven.
 *
 * Posture B is the one that actually delivers unlinkability against us, and it is
 * cheap: the derivation is `poseidon2Sponge` over a signature, which the same
 * Poseidon2 module runs client-side unchanged. Posture A exists because the live
 * `DeltaBridgeInput.identitySeedHex` parameter already has that shape and removing
 * it would be a regression; it is documented as the weaker of the two rather than
 * quietly presented as equivalent.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT NEITHER POSTURE GIVES YOU — unchanged by anything in this file
 * ════════════════════════════════════════════════════════════════════════════════
 * NOTHING HERE IS PROVEN. There is still no circuit. Posture B lets the engine
 * publish a nullifier it cannot itself recompute, which is a real improvement in
 * WHO CAN LINK — and it is simultaneously a reduction in what the engine can CHECK:
 * with no secret, `nullifierMatchesSecret` is unrunnable, so the engine takes the
 * holder's word that the nullifier was derived from the commitment's pre-image. A
 * malicious holder can send two unrelated values. Only the Plonky3 circuit closes
 * that, and until it lands `holderUnlinkability()` returns that limit in shape
 * rather than in prose, so no route can quietly upgrade the claim.
 *
 * That trade is stated rather than hidden: posture B moves the trust from "we can
 * link you" to "we cannot check you". Both are honest positions; neither is a proof.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVARIANT COMPLIANCE (ZKP_ARCHITECTURE_INVARIANTS v1)
 * ════════════════════════════════════════════════════════════════════════════════
 * 1. Poseidon2 over BabyBear ONLY. The seed KDF is `poseidon2Sponge`; the signature
 *    is absorbed as bytes. No sha256, no keccak, no ethers hashing — pinned by a
 *    test that greps this module's source.
 * 2. `scope` and `domain` stay PARAMETERS end to end. `bindingRowFor` takes both and
 *    absorbs whatever it is given: `scope='ownership'` under `domain='identity'` for
 *    agent ownership, `scope=studyId` under a health domain unchanged, no branch.
 * 3. `domain` is explicit, absorbed into the seed KDF AND into the nullifier, and
 *    checked to equal the value carried in the row — a stored nullifier whose domain
 *    column disagrees with the absorbed domain is unverifiable, so that is rejected.
 * 5. No new proving surface. Conventions over the already-pinned permutation.
 * 6. Domain strings are the circuit-registry namespace keys.
 *
 * DOES NOT BUILD THE HEALTH VERTICAL. Nothing here knows what a study is. The only
 * health-facing property is that `scope`/`domain` were not hardcoded — which costs
 * nothing and is the whole of "keep the door open".
 */

import { poseidon2Sponge, fieldsToHex } from './poseidon2-leaf';
import {
  feltsFromHex,
  feltsFromString,
  identitySecretFromHolderSeed,
  scopedNullifier,
  unlinkabilityOf,
  HOLDER_SEED_MIN_BYTES,
  IDENTITY_MASTER_ENV,
  type IdentitySecret,
  type UnlinkabilityStatement,
} from './nullifier-identity';

// ---------------------------------------------------------------------------
// Live table facts — verified, not remembered
// ---------------------------------------------------------------------------

/**
 * `human_agent_bindings` as it exists in production, read from `information_schema`
 * on 2026-08-04 [V]. Recorded here because `src/types/database.types.ts` is a known
 * stale surface and three phantom-column bugs in one night came from trusting it.
 *
 *   id             uuid        NOT NULL  default gen_random_uuid()
 *   human_token_id text        NULL
 *   human_wallet   text        NULL
 *   agent_id       uuid        NOT NULL  → FK repid_agents(id) ON DELETE CASCADE
 *   scope          text        NOT NULL  default 'ownership'
 *   domain         text        NOT NULL  default 'identity'
 *   nullifier      text        NULL
 *   binding_sig    text        NULL
 *   bound_at       timestamptz NOT NULL  default now()
 *   revoked_at     timestamptz NULL
 *   revoke_reason  text        NULL
 *   owner_kind     text        NOT NULL  default 'human_sbt'
 *   builder_id     uuid        NULL      → FK builders(id) ON DELETE CASCADE
 *
 * Constraints that this module enforces in code so a future writer cannot trip them:
 *   CHECK num_nonnulls(human_token_id, builder_id) = 1     (exactly one owner)
 *   CHECK owner_kind IN ('human_sbt', 'builder')
 *   UNIQUE (agent_id, scope) WHERE revoked_at IS NULL      (one live owner per scope)
 *
 * NOTE the table has NO column for the identity commitment. That is a real gap: the
 * commitment is the value that makes the nullifier a nullifier rather than a tag, and
 * without it a reader of this table cannot tell which identity a nullifier belongs to
 * even in principle. It is NOT invented here — this module returns the commitment
 * alongside the row so a caller can carry it (today: in the statement's
 * `identity_commitment`, which IS persisted, on `repid_zkp_proofs`), and the gap is
 * recorded for whoever adds the column.
 */
export const HUMAN_AGENT_BINDING_COLUMNS = [
  'id',
  'human_token_id',
  'human_wallet',
  'agent_id',
  'scope',
  'domain',
  'nullifier',
  'binding_sig',
  'bound_at',
  'revoked_at',
  'revoke_reason',
  'owner_kind',
  'builder_id',
] as const;

/** Live column DEFAULTS, not invented labels [V information_schema 2026-08-04]. */
export const BINDING_SCOPE_OWNERSHIP = 'ownership';
export const BINDING_DOMAIN_IDENTITY = 'identity';

/** `owner_kind` whitelist, from the live CHECK constraint. */
export const OWNER_KINDS = ['human_sbt', 'builder'] as const;
export type BindingOwnerKind = (typeof OWNER_KINDS)[number];

// ---------------------------------------------------------------------------
// The message the holder signs — deliberately NOT the binding message
// ---------------------------------------------------------------------------

/** Domain-separation tag for the seed KDF. Distinct from every tag in nullifier-identity. */
export const HOLDER_SEED_KDF_TAG = 'hyperdag/identity/holder-seed-kdf/v1';

/**
 * The exact text a holder signs to derive a nullifier seed.
 *
 * DIFFERENT TEXT from `bindingMessage(...)` in `src/services/human-agent-binding.ts`,
 * and the difference is the whole point: that signature is sent to the engine and
 * stored in `binding_sig`. This one must never leave the holder's machine, and the
 * message says so in the text a wallet will actually render, because the person
 * clicking Sign is the last line of defence against a UI that posts it anyway.
 *
 * `agentId` and `domain` are inside the message, so a seed signature captured for one
 * agent or one vertical cannot be replayed to derive the other's secret — the same
 * reasoning as the binding message, applied to the axis this module cares about.
 */
export function holderSeedMessage(params: {
  wallet: string;
  agentId: string;
  domain: string;
}): string {
  return [
    'HyperDAG — derive private nullifier seed',
    '',
    `wallet: ${params.wallet.toLowerCase()}`,
    `agent:  ${params.agentId}`,
    `domain: ${params.domain}`,
    '',
    'DO NOT SEND THIS SIGNATURE TO ANY SERVER. It is the pre-image of your private',
    'nullifier seed. Anyone who obtains it can link every action you take under this',
    'domain. Your wallet app derives the seed locally; only the derived values leave',
    'this device.',
    '',
    'This signs no transaction, moves no funds, and grants no spending authority.',
  ].join('\n');
}

/**
 * Seed := `Sponge(HOLDER_SEED_KDF_TAG ‖ domain ‖ signatureBytes)` → `0x`+64 hex.
 *
 * RUN THIS ON THE HOLDER'S DEVICE. It is exported from the engine's tree because the
 * engine and the holder must compute the identical value and a second implementation
 * is a second chance to diverge — not because the engine should be the one calling it.
 * Every call site inside this repo is a test or posture A.
 *
 * Poseidon2, not keccak, so the seed is aggregation-ready field material (Invariant 1)
 * and so the client needs exactly one hash family, the same one the circuit will use.
 *
 * The signature is absorbed with its length first (`feltsFromHex`), so a 64-byte and a
 * 65-byte signature over the same message cannot alias.
 */
export function deriveHolderSeed(params: { signatureHex: string; domain: string }): string {
  const sigFelts = feltsFromHex(params.signatureHex);
  const bytes = sigFelts.length - 1; // element 0 is the length prefix
  if (bytes < HOLDER_SEED_MIN_BYTES) {
    throw new Error(
      `[holder-identity-binding] signature is ${bytes} bytes; at least ` +
        `${HOLDER_SEED_MIN_BYTES} are required. A short pre-image is brute-forceable ` +
        `and would make the nullifier linkable by anyone, which is the failure this ` +
        `path exists to remove.`,
    );
  }
  return fieldsToHex(
    poseidon2Sponge([
      ...feltsFromString(HOLDER_SEED_KDF_TAG),
      ...feltsFromString(params.domain),
      ...sigFelts,
    ]),
  );
}

/**
 * THE GUARD. Refuse a seed that is derivable from a signature the database stores.
 *
 * See the header: `human_agent_bindings.binding_sig` is persisted, so a seed derived
 * from the binding signature has a pre-image readable by anyone with SELECT. This is
 * the single most likely way to implement the holder path wrongly — it is the version
 * that needs no extra UX — so it is blocked here rather than warned about.
 *
 * The check is exact, not heuristic: it recomputes the seed the binding signature
 * would produce under this domain and compares. It cannot catch a caller who used a
 * *different* persisted value as a pre-image, which is why the message text also
 * carries the warning; defence in depth, not a claim of completeness.
 *
 * Throws rather than returning false, because every caller of this would ignore a
 * boolean and the failure is silent by nature: a seed derived the wrong way produces
 * a perfectly well-formed, perfectly linkable nullifier.
 */
export function assertSeedIndependentOfBindingSignature(params: {
  seedHex: string;
  bindingSig: string | null | undefined;
  domain: string;
}): void {
  if (!params.bindingSig) return;
  let derived: string;
  try {
    derived = deriveHolderSeed({ signatureHex: params.bindingSig, domain: params.domain });
  } catch {
    // A binding_sig too short or non-hex to be a seed pre-image cannot be the source
    // of this seed. Nothing to reject.
    return;
  }
  if (derived.toLowerCase() === params.seedHex.toLowerCase()) {
    throw new Error(
      `[holder-identity-binding] the nullifier seed was derived from binding_sig. ` +
        `That column is PERSISTED, so the seed has a pre-image readable by anyone with ` +
        `SELECT on human_agent_bindings — every nullifier for this identity, in every ` +
        `scope and every domain, becomes recomputable. Sign holderSeedMessage() ` +
        `separately and never transmit that signature.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The two postures
// ---------------------------------------------------------------------------

export type HolderPosture = 'seed-to-engine' | 'client-computed';

/** What the engine ends up holding, for either posture. The secret is optional BY DESIGN. */
export interface HolderIdentity {
  posture: HolderPosture;
  /** `0x`+64 hex. Publishable. */
  commitment: string;
  /** `0x`+64 hex. Publishable. */
  nullifier: string;
  domain: string;
  scopeLabel: string;
  /**
   * Present ONLY in posture `seed-to-engine`. Null in `client-computed`, because in
   * that posture the engine genuinely has no secret — the absence is the property.
   * Never persist this, never log it, never return it from a handler; its `toJSON`
   * redacts the elements but the object itself must not travel.
   */
  secret: IdentitySecret | null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Posture A — the holder sent a seed. The engine derives the secret, publishes the
 * commitment and the nullifier, and keeps nothing.
 *
 * `bindingSig` is optional and exists only to feed the guard: pass the value that
 * will be written to `binding_sig` and a seed derived from it is refused.
 */
export function holderIdentityFromSeed(params: {
  seedHex: string;
  domain: string;
  scopeLabel: string;
  bindingSig?: string | null;
}): HolderIdentity {
  assertSeedIndependentOfBindingSignature({
    seedHex: params.seedHex,
    bindingSig: params.bindingSig,
    domain: params.domain,
  });
  const secret = identitySecretFromHolderSeed({
    seedHex: params.seedHex,
    domain: params.domain,
  });
  return {
    posture: 'seed-to-engine',
    commitment: secret.commitment,
    nullifier: scopedNullifier({ secret, domain: params.domain, scopeLabel: params.scopeLabel }),
    domain: params.domain,
    scopeLabel: params.scopeLabel,
    secret,
  };
}

/**
 * Posture A, secret only — for a caller that will compute its own scoped nullifier
 * (the statement layer does), so no nullifier is computed here and thrown away.
 *
 * This is the function `repid-delta-bridge.ts` calls, and it exists so the binding_sig
 * guard runs on the LIVE wire rather than only where someone remembers to invoke it.
 * The bridge previously called `identitySecretFromHolderSeed` directly, which skips the
 * guard entirely.
 */
export function holderSecretFromSeed(params: {
  seedHex: string;
  domain: string;
  bindingSig?: string | null;
}): IdentitySecret {
  assertSeedIndependentOfBindingSignature({
    seedHex: params.seedHex,
    bindingSig: params.bindingSig,
    domain: params.domain,
  });
  return identitySecretFromHolderSeed({ seedHex: params.seedHex, domain: params.domain });
}

/**
 * Posture B — the holder computed both values locally and sent only those.
 *
 * The engine cannot check that these two are related; that is the trade the header
 * spells out, and `holderUnlinkability` reports it. What CAN be checked is checked:
 * both must be canonical 32-byte digests, and they must differ (identical values mean
 * a caller wired one variable into both slots, which would make every scope of that
 * identity share a nullifier — a de-duplication failure that looks like success).
 */
export function holderIdentityFromPublished(params: {
  commitment: string;
  nullifier: string;
  domain: string;
  scopeLabel: string;
}): HolderIdentity {
  const c = params.commitment.toLowerCase();
  const n = params.nullifier.toLowerCase();
  if (!HEX32.test(c)) {
    throw new Error(
      `[holder-identity-binding] identity commitment must be 0x+64 hex, got '${params.commitment}'`,
    );
  }
  if (!HEX32.test(n)) {
    throw new Error(
      `[holder-identity-binding] nullifier must be 0x+64 hex, got '${params.nullifier}'. A ` +
        `narrower value collides between honest events — see nullifier-identity.ts.`,
    );
  }
  if (c === n) {
    throw new Error(
      `[holder-identity-binding] commitment equals nullifier. These are different ` +
        `functions of the secret; equal values mean one variable was wired into both ` +
        `slots, and every scope of this identity would then share a nullifier.`,
    );
  }
  return {
    posture: 'client-computed',
    commitment: c,
    nullifier: n,
    domain: params.domain,
    scopeLabel: params.scopeLabel,
    secret: null,
  };
}

// ---------------------------------------------------------------------------
// Honest claim surface
// ---------------------------------------------------------------------------

/**
 * Who can link a nullifier from this module, and what is still unproven.
 *
 * Composes `unlinkabilityOf` for posture A rather than restating it, so the two cannot
 * drift, and REPLACES its operator line for posture B, where the operator genuinely
 * never sees a secret. `proven` stays `false` in both — nothing here adds a
 * cryptographic guarantee about the derivation, and the `unproven` list says so
 * explicitly rather than leaving the improvement to be read as a proof.
 */
export interface HolderUnlinkability extends UnlinkabilityStatement {
  posture: HolderPosture;
  /** What a verifier still cannot know. Never empty, in either posture. */
  unproven: string[];
}

export function holderUnlinkability(id: HolderIdentity): HolderUnlinkability {
  const unprovenCommon = [
    'that the nullifier was derived from the secret behind the commitment ' +
      '(binding is asserted, not proven — needs the Plonky3 circuit)',
    'that the holder is a distinct human rather than one key controlling many ' +
      'identities (needs populated proof-of-human material; human_sbt_mints holds ' +
      'ONE row and it is a mock [V SQL 2026-08-04])',
  ];

  if (id.posture === 'seed-to-engine') {
    // Reuse the audited statement for a holder-supplied secret verbatim.
    const base = unlinkabilityOf(id.secret!);
    return {
      ...base,
      posture: 'seed-to-engine',
      unproven: [
        ...unprovenCommon,
        'that the engine did not retain the seed it was sent — "not persisted" is a ' +
          'property of this code path, not something a caller can verify from outside',
      ],
    };
  }

  return {
    source: 'holder-supplied',
    posture: 'client-computed',
    unlinkable_by: [
      'anyone reading the published statement (nullifier pre-image is ~248 bits)',
      'anyone with SELECT on the database (no secret is stored)',
      `anyone holding ${IDENTITY_MASTER_ENV} (it is not used on this path)`,
      'an operator who logs every request — the engine never receives a secret at all, ' +
        'which is the difference between this posture and seed-to-engine',
    ],
    linkable_by: ['the holder themselves'],
    proven: false,
    unproven: [
      ...unprovenCommon,
      'that these two published values are related AT ALL — with no secret, the engine ' +
        'cannot run nullifierMatchesSecret, so a malicious holder may send unrelated ' +
        'values and nothing here detects it. This posture trades "we can link you" for ' +
        '"we cannot check you"; the circuit is what removes both.',
    ],
  };
}

// ---------------------------------------------------------------------------
// The row — fits `human_agent_bindings`, writes nothing
// ---------------------------------------------------------------------------

/**
 * Exactly the columns a writer would supply. Server-defaulted columns (`id`,
 * `bound_at`) are deliberately absent: emitting them would override the database's
 * own defaults for no reason and is how a "shape" quietly becomes a policy.
 */
export interface HumanAgentBindingRow {
  agent_id: string;
  scope: string;
  domain: string;
  nullifier: string;
  binding_sig: string | null;
  human_wallet: string | null;
  owner_kind: BindingOwnerKind;
  human_token_id: string | null;
  builder_id: string | null;
}

export interface BindingRowResult {
  row: HumanAgentBindingRow;
  /**
   * The identity commitment. NOT a column on `human_agent_bindings` — see the note on
   * `HUMAN_AGENT_BINDING_COLUMNS`. Returned separately so a caller carries it
   * deliberately (into the statement's `identity_commitment`) instead of dropping it.
   */
  identity_commitment: string;
  unlinkability: HolderUnlinkability;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the row for a holder binding, and enforce the live table's constraints here so
 * a violation is a thrown error in a unit test rather than a 23514 in production.
 *
 * Checks, each mapping to a real constraint or to a real unverifiability:
 *   - `agent_id` is a uuid            → the column is uuid, FK to repid_agents(id)
 *   - exactly one of human_token_id / builder_id → CHECK num_nonnulls(...) = 1
 *   - owner_kind in the whitelist     → CHECK owner_kind IN (...)
 *   - owner_kind agrees with which owner id was given → not a DB constraint, but a row
 *     claiming `human_sbt` while carrying only a `builder_id` misstates the assurance
 *     level, and assurance is the one thing that column exists to record
 *   - `domain` equals the domain absorbed into the nullifier → NOT a DB constraint and
 *     the most dangerous of the lot: the nullifier is `Sponge(tag ‖ secret ‖ domain ‖
 *     scope)`, so a row whose `domain` column disagrees with the absorbed value is
 *     unverifiable by anyone, forever, and looks completely normal
 *   - `scope` equals the absorbed scopeLabel → same reasoning, same silence
 *
 * The (agent_id, scope) uniqueness for live rows is a DATABASE-side property (a partial
 * unique index) and is deliberately NOT simulated here: this module reads nothing, so
 * any check it made would be a guess. The writer must handle the conflict.
 */
export function bindingRowFor(params: {
  identity: HolderIdentity;
  agentId: string;
  ownerKind: BindingOwnerKind;
  humanTokenId?: string | null;
  builderId?: string | null;
  humanWallet?: string | null;
  bindingSig?: string | null;
}): BindingRowResult {
  const { identity } = params;

  if (!UUID_RE.test(params.agentId)) {
    throw new Error(
      `[holder-identity-binding] human_agent_bindings.agent_id is uuid NOT NULL with an ` +
        `FK to repid_agents(id); got '${params.agentId}'. repid_agents carries BOTH a uuid ` +
        `\`id\` and a text \`agent_id\` — the binding references the uuid.`,
    );
  }
  if (!OWNER_KINDS.includes(params.ownerKind)) {
    throw new Error(
      `[holder-identity-binding] owner_kind must be one of ${OWNER_KINDS.join(' | ')}, ` +
        `got '${params.ownerKind}'`,
    );
  }

  const humanTokenId = params.humanTokenId ?? null;
  const builderId = params.builderId ?? null;
  const owners = [humanTokenId, builderId].filter((v) => v !== null).length;
  if (owners !== 1) {
    throw new Error(
      `[holder-identity-binding] CHECK num_nonnulls(human_token_id, builder_id) = 1 — ` +
        `exactly one owner reference is required, got ${owners}.`,
    );
  }
  if (params.ownerKind === 'human_sbt' && humanTokenId === null) {
    throw new Error(
      `[holder-identity-binding] owner_kind='human_sbt' but no human_token_id. That row ` +
        `would claim proof-of-human assurance on a builder-only binding.`,
    );
  }
  if (params.ownerKind === 'builder' && builderId === null) {
    throw new Error(
      `[holder-identity-binding] owner_kind='builder' but no builder_id.`,
    );
  }

  // The two silent killers: a stored domain/scope that is not what the nullifier
  // absorbed makes the row unverifiable and looks entirely normal.
  if (identity.domain.length === 0) {
    throw new Error('[holder-identity-binding] domain must be a non-empty absorbed value');
  }
  if (identity.scopeLabel.length === 0) {
    throw new Error('[holder-identity-binding] scope must be a non-empty absorbed value');
  }

  return {
    row: {
      agent_id: params.agentId,
      // Absorbed values, carried verbatim. NOT the column defaults: the defaults
      // ('ownership' / 'identity') are what a caller SHOULD pass for agent ownership,
      // but silently substituting them here would produce exactly the mismatch above.
      scope: identity.scopeLabel,
      domain: identity.domain,
      nullifier: identity.nullifier,
      binding_sig: params.bindingSig ?? null,
      human_wallet: params.humanWallet ?? null,
      owner_kind: params.ownerKind,
      human_token_id: humanTokenId,
      builder_id: builderId,
    },
    identity_commitment: identity.commitment,
    unlinkability: holderUnlinkability(identity),
  };
}

/**
 * Recheck a stored row against a secret you hold — the honest-PROVER check, at the row
 * level. Same limit as `nullifierMatchesSecret`: it convinces someone who already has
 * the secret, which is not the party that needs convincing, and it is unrunnable in
 * posture `client-computed` by construction. Returns false rather than throwing so a
 * caller can sweep a table without a try/catch per row.
 */
export function rowMatchesSecret(row: HumanAgentBindingRow, secret: IdentitySecret): boolean {
  try {
    return (
      scopedNullifier({ secret, domain: row.domain, scopeLabel: row.scope }).toLowerCase() ===
      row.nullifier.toLowerCase()
    );
  } catch {
    return false;
  }
}
