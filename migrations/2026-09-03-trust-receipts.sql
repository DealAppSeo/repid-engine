-- 2026-09-03-trust-receipts.sql
-- DRAFT — apply is Sean-GO'd (RULE-2). Additive + reversible. RLS-on by default.
--
-- The WRITE-SIDE Trust Receipt: the settlement record the Policy Gate
-- (src/kernel/policy-gate.ts) requires before durable RepID may move in ENFORCE
-- mode. NOT the read-side src/services/trust-receipt.ts (that assembles the PUBLIC
-- /receipt report from service_contracts/x402/score_events — keep it).
--
-- Grok's rule: stores evidence tuples, NOT a baked repid_score. Born multi-entity +
-- composition-lineage so we never migrate the shape again.

CREATE TABLE IF NOT EXISTS public.trust_receipts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id                   text,
  contract_id               text,
  action_class              text NOT NULL,

  subject_type              text NOT NULL DEFAULT 'agent'
                            CHECK (subject_type IN ('agent','validator','selector','model','tool','skill','mcp')),
  subject_agent_id          uuid,

  principal_id              text,
  capsule_id                text,
  composition_hash          text,
  parent_composition_hash   text,
  change_class              text CHECK (change_class IN ('none','minor','major')),
  execution_id              text,

  claim_ids                 uuid[] DEFAULT '{}',
  validation_ids            uuid[] DEFAULT '{}',
  evidence_predicate_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  hal_evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,

  gate_decision             text NOT NULL CHECK (gate_decision IN ('ALLOW','ASK','DENY')),
  gate_reasons              jsonb NOT NULL DEFAULT '[]'::jsonb,
  authorized_delta          integer NOT NULL DEFAULT 0,
  outcome                   text CHECK (outcome IN ('success','fail','escalate')),

  evidence_merkle_root      text,
  constitution_hash         text,
  policy_version            text,
  residency                 jsonb DEFAULT '{}'::jsonb,

  settled_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_receipts_subject  ON public.trust_receipts (subject_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_receipts_contract ON public.trust_receipts (contract_id);

ALTER TABLE public.trust_receipts ENABLE ROW LEVEL SECURITY;

-- The spine link. Nullable first (backfill/cutover); NOT NULL only after every
-- writer routes durable moves through the gate. Do NOT set NOT NULL here.
ALTER TABLE public.repid_score_events
  ADD COLUMN IF NOT EXISTS settled_receipt_id uuid REFERENCES public.trust_receipts(id);

-- INVARIANT (enforced by gate() in app code first; by a trigger after cutover):
--   an event with non-zero repid_delta_applied MUST carry a settled_receipt_id
--   whose gate_decision='ALLOW' and authorized_delta = repid_delta_applied.

-- rollback:
--   ALTER TABLE public.repid_score_events DROP COLUMN IF EXISTS settled_receipt_id;
--   DROP TABLE IF EXISTS public.trust_receipts;
