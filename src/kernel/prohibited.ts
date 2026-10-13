/**
 * prohibited.ts — Mission 1, the hard floor UNDER the owner policy.
 *
 * Some capabilities are refused REGARDLESS of the owner policy, the agent's trust tier, or any
 * stake: exporting a secret, and writing to trusted memory. "Autonomy = AND(owner grant ∧ policy ∧
 * context ∧ trust threshold ∧ risk limits); stake is bounded exposure, NEVER a bypass of a
 * prohibited action." So this is screened in `decide()` BEFORE policy/limit/HAL evidence is weighed:
 * a fully-permissive, VERIFIED, unexpired signed policy cannot allow a prohibited capability, and the
 * refusal is written into the receipt (`prohibited_action`).
 *
 * THREAT: a poisoned repo (untrusted content the agent ingested) steers a tool call toward
 *   - secret_export        — exfiltrate a credential / key / env, or
 *   - trusted_memory_write — poison the agent's durable, trusted memory.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH. The MVP has no tool registry and `tool.class` is
 * caller-asserted (the receipt already records that in `does_not_attest`). This screens the tool's
 * DECLARED name against a canonical set of prohibited-capability patterns, so a tool that PRESENTS as
 * a secret-export or trusted-memory-write capability is refused. It does NOT detect a tool that
 * MISREPRESENTS its capability behind an innocent name — that is the tool-attestation gap the receipt
 * already flags, and hardening the pattern set / threat model against evasion is XC1's review (this
 * PR is handed back flagged for it). Matching is a floor, not a ceiling: additions only ever refuse
 * more.
 */
import type { KernelRequest, Reason } from './types';

export type ProhibitedCapability = 'secret_export' | 'trusted_memory_write';

// A credential/secret being read out, dumped, revealed or sent somewhere.
const SECRET_EXPORT =
  /(?:^|[._/:-])(?:export|exfiltrate|reveal|dump|leak|disclose|send|post|upload|share|print)[._/:-]?(?:the[._/:-]?)?(?:secret|secrets|credential|credentials|api[._/:-]?key|api[._/:-]?keys|private[._/:-]?key|priv[._/:-]?key|env|dotenv|keyring|keystore|token|mnemonic|seed[._/:-]?phrase)s?\b/i;
// A secret/credential namespace being read out or sent somewhere.
const SECRET_NAMESPACE =
  /(?:^|[._/:-])(?:secret|secrets|credential|credentials|keyring|keystore|vault|env|dotenv)[._/:-](?:export|read|get|reveal|dump|list|all|send|post|fetch|copy|upload|exfiltrate|leak|disclose|share|print)\b/i;
// A write to TRUSTED / canonical / root memory (poisoning the durable store).
const TRUSTED_MEMORY_WRITE =
  /(?:^|[._/:-])(?:trusted[._/:-]?memory|memory[._/:-]?trusted|canonical[._/:-]?memory|root[._/:-]?memory)[._/:-]?(?:write|set|put|store|append|upsert|update|save|insert|commit)\b/i;
// A memory write that targets the trusted/canonical/root tier.
const MEMORY_WRITE_TRUSTED =
  /(?:^|[._/:-])(?:memory|mem)[._/:-](?:write|set|put|store|append|upsert|update|save|insert|commit)[._/:-]?(?:trusted|canonical|root|verified)\b/i;

/** Classify a tool name as a hard-prohibited capability, or null. PURE. */
export function classifyProhibited(toolName: unknown): ProhibitedCapability | null {
  const n = typeof toolName === 'string' ? toolName : '';
  if (SECRET_EXPORT.test(n) || SECRET_NAMESPACE.test(n)) return 'secret_export';
  if (TRUSTED_MEMORY_WRITE.test(n) || MEMORY_WRITE_TRUSTED.test(n)) return 'trusted_memory_write';
  return null;
}

export interface ProhibitionScreen {
  prohibited: boolean;
  capability: ProhibitedCapability | null;
  /** The decision reason to record when prohibited, or null. `detail` carries no secret value. */
  reason: Reason | null;
}

/** Screen a request for a hard-prohibited capability. PURE; reads only the declared tool name. */
export function screenProhibited(request: Pick<KernelRequest, 'tool'> | null | undefined): ProhibitionScreen {
  const cap = classifyProhibited(request?.tool?.name);
  if (!cap) return { prohibited: false, capability: null, reason: null };
  return {
    prohibited: true,
    capability: cap,
    reason: {
      code: 'prohibited_action',
      detail: `the tool presents a hard-prohibited capability (${cap}); refused regardless of owner policy, trust or stake`,
    },
  };
}
