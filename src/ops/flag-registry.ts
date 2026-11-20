// src/ops/flag-registry.ts
//
// The names GET /api/v1/ops/flags may report, and the rule for what it may say
// about each one's value.
//
// ── WHERE THE LIST CAME FROM ────────────────────────────────────────────────
//
// Generated once (2026-11-14) and committed. It is never computed from
// process.env, so setting a variable on Railway cannot make it appear here.
// The rule that produced it:
//
//   * every name in src/config/known-env-vars.generated.ts that ends in
//     _ENABLED, _MODE, _ENFORCE, _ENFORCED or _STRICTNESS, starts with
//     HAL_S2_ENABLE_, or contains SHADOW;
//   * plus every key src/hal/config.ts resolves from repid_config (ALL_KEYS);
//   * minus every name matching the secret fence in tests/ops-flags.test.ts
//     (KEY, SECRET, TOKEN, PASSWORD, PRIVATE, SEED, MNEMONIC, URL, ADDRESS,
//     DSN, WEBHOOK). The fence drops three real boolean flags because their
//     names contain KEYS or TOKENS: AGENT_SELF_SERVE_KEYS_ENABLED,
//     IDENTITY_TOKENS_ENABLED, TOKEN_SIGNUP_ENABLED. That is on purpose: the
//     fence matches names, not meanings.
//
// tests/ops-flags.test.ts re-derives the list from that rule and fails if it
// differs from this one, in either direction. So a new flag-shaped variable
// cannot go unlisted without a red test, and a flag that stops being read
// cannot stay listed. When it fails, it prints the names to add or remove.
//
// Newline-delimited template string, the same form as known-env-vars.generated.ts
// and for the same reason (gitleaks reads adjacent quoted ALL_CAPS names as
// key/value pairs).
export const FLAG_REGISTRY: readonly string[] = `
AGENT_GATE_ENABLED
AGENT_SPEND_ENABLED
ANFIS_RETUNE_ENABLED
ANFIS_ROUTING_MODE
ANFIS_SHADOW_PERSIST
ARENA_ENABLED
BFT_DISJOINT_ENFORCE
BIRTH_RATE_BREAKER_MODE
BYOK_CUSTODY_ENABLED
CASCADE_SETTLEMENT_ENABLED
CASCADE_SPECULATION_ENABLED
CONFIRMED_FAILED_SETTLE_MODE
CONFIRMED_OUTCOME_SCORING_ENABLED
CONSTITUTIONAL_AUDIT_ENABLED
COSIGN_CONSUMER_ENABLED
DECAY_BOUND_MODE
DELTA_REJECT_ENFORCE
DEV_CODEGEN_ENABLED
DISPUTE_WORKER_ENABLED
DURABLE_CAPS_ENABLED
EAS_ANCHOR_WORKER_ENABLED
EAS_CONTINUOUS_ANCHOR_ENABLED
EMERGENCY_HALT_MODE
ENGINE_LEDGER_RECONCILE_MODE
ENGINE_WORKERS_ENABLED
EXECUTION_FLOOR_ENABLED
EXPERIMENTAL_REPID_MODE
FREE_TIER_QUOTA_SHADOW_ENABLED
GASLESS_DEPOSIT_MODE
GROUNDING_MODE
HAL_CHRONIC_FLAG_ENABLED
HAL_DECISION_MODE
HAL_DECISION_REQUIRES_QUORUM
HAL_ENRICHMENT_ENABLED
HAL_GROUNDING_MODE
HAL_JEV_PREFILTER_ENABLED
HAL_LOCAL_FALLBACK_ENABLED
HAL_PENALTY_REQUIRES_QUORUM
HAL_QUORUM_RECEIPT_ENABLED
HAL_RETRIEVAL_ENABLED
HAL_S2_ENABLE_ANTHROPIC
HAL_S2_ENABLE_CEREBRAS
HAL_S2_ENABLE_DEEPSEEK
HAL_S2_ENABLE_FIREWORKS
HAL_S2_ENABLE_FRONTIER
HAL_S2_ENABLE_FRONTIER_FREE
HAL_S2_ENABLE_GEMINI
HAL_S2_ENABLE_GLOO
HAL_S2_ENABLE_GROQ
HAL_S2_ENABLE_MISTRAL
HAL_S2_ENABLE_NIM
HAL_S2_ENABLE_NVIDIA_NIM
HAL_S2_ENABLE_OPENROUTER
HAL_S2_ENABLE_QWEN
HAL_S2_ENABLE_TOGETHER
HAL_S2_ENABLE_ZAI
HAL_SBFA_ENFORCE
HAL_SBFA_SHADOW
HAL_SCORE_GATE_MODE
HAL_SIGNED_RECEIPT_ENABLED
HAL_SIGNED_RECEIPT_VERIFY_ENABLED
HAL_STRICTNESS
HAL_STRICT_MODE
HAL_TRUE_QUORUM_SHADOW_RECORD
HAL_VERDICT_RECEIPT_ID_ENABLED
HEALTH_PROBE_ENABLED
HEAT_EVICTION_ENABLED
HEAT_EVICTION_SHADOW_ENABLED
HELP_B_WRITES_ENABLED
HITL_CALLBACK_ENABLED
HITL_EXPIRATION_ENABLED
HITL_EXPIRY_SWEEPER_ENABLED
HITL_RECONCILE_MODE
HUMAN_AGENT_BIND_ENABLED
HUMAN_SBT_OWNER_BUDGET_ENABLED
IMMUNE_ANCHOR_ENABLED
IMMUNE_PERSIST_ENABLED
IMMUNE_SETTLE_ENABLED
KERNEL_CAPABILITY_REGISTRY_ENABLED
KERNEL_HAL_ENABLED
LINEAGE_DEPTH_MODE
LISTING_BRIDGE_ENABLED
LLM_OLLAMA_FLOOR_ENABLED
LOCAL_MODE
MEMORY_ROOT_ANCHOR_SWEEP_ENABLED
NOTIFICATION_DISPATCHER_ENABLED
ONCHAIN_REPUTATION_TRIGGER_ENABLED
OPENAI_COMPAT_ENABLED
OWNER_BUDGET_MODE
OWNER_CEILING_SHADOW_ENABLED
OWNER_DISTINCT_SHADOW
PARTICIPANT_RATING_MODE
PAYMENT_ANCHOR_VERIFY_MODE
PEER_VERIFY_PANEL_ENABLED
PEER_VERIFY_PREFILTER_MODE
PEER_VERIFY_REPID_ENABLED
POSTCARD_COMMITMENT_MODE
PROOF_DRAIN_CHURN_MODE
PROOF_ENQUEUE_HAL_MODE
PROOF_REFRESH_ENABLED
PROOF_TIER_SHADOW_ENABLED
REAL_STAKING_ENABLED
RECEIPT_SIGNING_ENABLED
RED_TEAM_AUDIT_MODE
REGISTRATION_SLOTS_ENABLED
REPIDSYNC_WORKER_ENABLED
REPID_ACTIVE_GATE_MODE
REPID_DECAY_MODE
REPID_DELTA_STATEMENT_MODE
REPID_PURPOSE_GATE_ENABLED
RESILIENCE_SHADOW_LOG
ROUTER_ANFIS_SHADOW
RPC_ROTATION_ENABLED
SAME_OWNER_SETTLEMENT_MODE
SBFA_SHADOW_SAMPLE_RATE
SCORE_EVENT_GUARD_MODE
SELF_REPORT_EVIDENCE_MODE
SELF_SERVE_ACCOUNTS_ENABLED
SERVICE_DELIVERY_CHECK_MODE
SERVICE_QUALITY_HOOK_MODE
SETTLEMENT_SCORE_SHADOW_ENABLED
SIGNED_JOB_VERIFY_ENABLED
STAKE_AUTHORITY_SHADOW_ENABLED
STAKE_DEPOSIT_AUTH_ENFORCED
STATUS_DIGEST_ENABLED
T12_LANES_ENABLED
TASK_VERIFY_LEG_MODE
TRINITY_BRIDGE_ENABLED
TRINITY_BRIDGE_KNOWN_ANSWER_MODE
TRUST_DECEPTION_MODE
TYPED_VERDICT_SHADOW_ENABLED
VALIDATION_WORKER_ENABLED
VERSION_PERSIST_ENABLED
X402_ENFORCEMENT_ENABLED
X402_GATE_SHADOW
X402_RECOVERY_WORKER_ENABLED
X402_RELEASE_RETRY_ENABLED
ZKP_CARDS_ENABLED
`.trim().split('\n');

/**
 * Raw env values that may be echoed. Mode words seen in this repo's flag readers
 * (off/shadow/enforce, live, active, canonical, ...), the boolean spellings, and
 * yes/no/enabled/disabled so a typo shows up as itself. Matched case-insensitively
 * and echoed exactly as set, so `TRUE` is reported as `TRUE`: for a gate that
 * compares `=== 'true'` that value is off, and the reader needs to see it.
 */
const MODE_WORDS = new Set([
  'on', 'off', 'true', 'false', 'yes', 'no', 'enabled', 'disabled',
  'shadow', 'enforce', 'enforced', 'live', 'active', 'canonical', 'verdict',
  'sha256', 'escalate_only', 'tier0_only',
]);

/** Digits, or a short decimal such as a sample rate (SBFA_SHADOW_SAMPLE_RATE). */
const NUMBER = /^\d{1,6}(\.\d{1,6})?$/;

/**
 * What the endpoint may say about one env value. Never the value itself unless
 * it is a mode word or a number.
 *
 * - `unset`: the variable is not set, so the code's own default applies. This
 *   does NOT say what that default is.
 * - a mode word or number, echoed exactly as set (`on`, `off`, `shadow`, `2`).
 * - `set`: anything else, including the empty string. Set, not echoed.
 *
 * `true` is NOT turned into `on`. This is the environment's value, not the
 * flag's own parse of it: X402_RELEASE_RETRY_ENABLED takes off|shadow|enforce,
 * and `true` resolves to off there. Reporting `on` would be a lie for that flag.
 */
export function classifyEnvValue(raw: string | undefined): string {
  if (raw === undefined) return 'unset';
  if (MODE_WORDS.has(raw.toLowerCase()) || NUMBER.test(raw)) return raw;
  return 'set';
}
