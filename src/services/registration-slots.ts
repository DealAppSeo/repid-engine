// Credential slots in the ERC-8004 registration file, under the `hyperdag` namespace.
//
// Decision D-113 (Sean, 2026-10-16): N = 3 owner-chosen slots, each a claim plus a proof
// pointer, with issuer and expiry; FULL HISTORY. Design: living-docs
// 03_specs/IDENTITY_CARD_AND_LIVE_PROFILE_v0_2026-10-16.md §4.
//
// THE CHAIN. `history` is append-only: entry i carries prev_hash = slotEntryHash(entry i-1)
// (null for the first). Replacing slot k appends a new entry for k; the old entry stays in
// `history` and stays verifiable. `current` is DERIVED from history (the last entry per slot),
// so a served `current` that disagrees with its own history fails validation.
//
// THE HASH is Poseidon2 over BabyBear (ZKP invariant 1), the same sponge and the same
// length-prefixed byte encoding as src/zkp/nullifier-identity.ts, over canonical JSON.
//
// PURE: no database, no chain, no write path. Every current owner is an engine-held key and
// human holder bindings are 0 (design §8), so nothing may write a slot yet.
// ponytail: no owner-signature check here (EIP-712 by ownerOf at signing time needs a chain
// read); it lands with the write endpoint, as does a removal tombstone.
import { canonicalJson } from './owner-authorization';
import { poseidon2Sponge, fieldsToHex } from '../zkp/poseidon2-leaf';
import { feltsFromString } from '../zkp/nullifier-identity';

export const MAX_SLOTS = 3;
export const SLOT_ENTRY_TAG = 'hyperdag/credential/slot-entry/v1';

export interface SlotEntry {
  slot: number; // 1..MAX_SLOTS
  type: string; // dotted identifier, e.g. "chess.rating" (no free text: design §4.1)
  issuer: { agentRegistry: string; agentId: number };
  claim: { metric: string; op: '>=' | '<=' | '=='; value: number };
  proof: { kind: 'eas' | 'plonky3-range' | 'self'; ref: string };
  issued_at: string; // YYYY-MM-DD (day granularity: design §8)
  expires_at: string; // YYYY-MM-DD, mandatory, after issued_at
  prev_hash: string | null; // slotEntryHash of the previous history entry
}

export interface SlotState {
  max: number;
  head: string | null; // slotEntryHash of the last history entry
  current: SlotEntry[];
  history: SlotEntry[];
}

export function slotEntryHash(entry: SlotEntry): string {
  return fieldsToHex(poseidon2Sponge([...feltsFromString(SLOT_ENTRY_TAG), ...feltsFromString(canonicalJson(entry))]));
}

/** The served slot state for a history: current = last entry per slot, head = hash of the last entry. */
export function slotStateFromHistory(history: SlotEntry[]): SlotState {
  const bySlot = new Map<number, SlotEntry>();
  for (const e of history) bySlot.set(e.slot, e);
  return {
    max: MAX_SLOTS,
    head: history.length ? slotEntryHash(history[history.length - 1]!) : null,
    current: [...bySlot.values()].sort((a, b) => a.slot - b.slot),
    history,
  };
}

const DOTTED_ID = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CAIP10_REGISTRY = /^eip155:\d+:0x[0-9a-fA-F]{40}$/;
const OPS = ['>=', '<=', '=='];
const PROOF_KINDS = ['eas', 'plonky3-range', 'self'];

function entryProblem(e: SlotEntry): string | null {
  if (!Number.isInteger(e?.slot) || e.slot < 1 || e.slot > MAX_SLOTS) return `slot must be 1..${MAX_SLOTS}`;
  if (!DOTTED_ID.test(e.type ?? '')) return 'type must be a dotted identifier';
  if (!CAIP10_REGISTRY.test(e.issuer?.agentRegistry ?? '') || !Number.isSafeInteger(e.issuer?.agentId)) return 'issuer must be {agentRegistry, agentId}';
  if (!DOTTED_ID.test(e.claim?.metric ?? '') || !OPS.includes(e.claim?.op) || !Number.isFinite(e.claim?.value)) return 'claim must be {metric, op, value}';
  if (!PROOF_KINDS.includes(e.proof?.kind) || typeof e.proof?.ref !== 'string' || !e.proof.ref) return 'proof must be {kind, ref}';
  if (!DAY.test(e.issued_at ?? '') || !DAY.test(e.expires_at ?? '') || !(e.expires_at > e.issued_at)) return 'issued_at < expires_at, both YYYY-MM-DD';
  return null;
}

/** VERIFIED or FAILED with the first problem found. Walks the whole chain; trusts nothing served. */
export function validateSlotState(s: SlotState): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (s?.max !== MAX_SLOTS || !Array.isArray(s.history) || !Array.isArray(s.current)) return fail('malformed slot state');
  let prev: string | null = null;
  for (const [i, e] of s.history.entries()) {
    const problem = entryProblem(e);
    if (problem) return fail(`history[${i}]: ${problem}`);
    if (e.prev_hash !== prev) return fail(`history[${i}]: prev_hash does not match the entry before it`);
    prev = slotEntryHash(e);
  }
  if (s.head !== prev) return fail('head does not match the last history entry');
  if (canonicalJson(s.current) !== canonicalJson(slotStateFromHistory(s.history).current)) return fail('current does not match history');
  return { ok: true };
}
