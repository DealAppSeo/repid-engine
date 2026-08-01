-- ============================================================================
-- A2A NEGOTIATION — PROPOSED DDL. DO NOT APPLY FROM AN AGENT.
-- Single writer applies; log the DDL. Additive net-new objects only.
-- NOTHING here alters service_contracts or agent_services.
--
-- PRE-FLIGHT (fail loudly rather than guess):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public'
--      AND (table_name, column_name) IN
--          (('repid_agents','id'),('agent_services','id'),('service_contracts','id'));
--   All three MUST be uuid. If any is not, the FKs below will fail — that is
--   the desired failure, not something to work around.
-- ============================================================================

-- ── 1. a2a_rfqs — the demand side, which has no representation today ────────
CREATE TABLE public.a2a_rfqs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_agent_id     uuid NOT NULL REFERENCES public.repid_agents(id),
  service_type       text NOT NULL,
  scope              jsonb NOT NULL,
  -- Buyer-committed reserve. The 10000 raw floor ($0.01) exists because RepID
  -- reward is PRICE-DECOUPLED: without it a 1-raw-unit contract pays the same
  -- reputation as a $10 one, which makes negotiation a RepID minting machine.
  min_price_usdc_raw bigint NOT NULL DEFAULT 10000 CHECK (min_price_usdc_raw >= 10000),
  max_price_usdc_raw bigint CHECK (max_price_usdc_raw IS NULL OR max_price_usdc_raw > 0),
  -- 1000 = ESTABLISHED. Listing an agent_services row is free and ungated
  -- (src/routes/v1/services.ts:6-24), so RepID is the only real sybil price.
  min_provider_repid integer NOT NULL DEFAULT 1000 CHECK (min_provider_repid >= 1000),
  award_mode         text NOT NULL DEFAULT 'sealed_close'
                       CHECK (award_mode IN ('sealed_close','immediate')),
  max_rounds         smallint NOT NULL DEFAULT 3 CHECK (max_rounds BETWEEN 1 AND 5),
  max_bids           smallint NOT NULL DEFAULT 25 CHECK (max_bids BETWEEN 1 AND 100),
  bids_close_at      timestamptz NOT NULL,
  close_extensions   smallint NOT NULL DEFAULT 0 CHECK (close_extensions BETWEEN 0 AND 3),
  expires_at         timestamptz NOT NULL,
  deadline_at        timestamptz,
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','closed','awarded','expired','cancelled')),
  outcome            text CHECK (outcome IN ('awarded','expired_no_award','expired_no_bids','cancelled_by_buyer')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT a2a_rfqs_window_ck     CHECK (bids_close_at <= expires_at),
  CONSTRAINT a2a_rfqs_price_band_ck CHECK (max_price_usdc_raw IS NULL OR max_price_usdc_raw >= min_price_usdc_raw)
);
CREATE INDEX a2a_rfqs_open_idx    ON public.a2a_rfqs (status, service_type, bids_close_at);
CREATE INDEX a2a_rfqs_buyer_idx   ON public.a2a_rfqs (buyer_agent_id, created_at DESC);
CREATE INDEX a2a_rfqs_expiry_idx  ON public.a2a_rfqs (expires_at) WHERE outcome IS NULL;

-- ── 2. a2a_bids — ONE negotiation thread per (RFQ, provider) ────────────────
CREATE TABLE public.a2a_bids (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                uuid NOT NULL REFERENCES public.a2a_rfqs(id),
  provider_agent_id     uuid NOT NULL REFERENCES public.repid_agents(id),
  service_id            uuid NOT NULL REFERENCES public.agent_services(id),
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','countered','withdrawn','accepted','lost','expired','rejected')),
  rounds_used           smallint NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
  current_round_id      uuid,  -- FK added after a2a_bid_rounds exists (see §3)
  provider_repid_at_bid integer,
  -- INERT ON PURPOSE. Forfeiture needs a new eventType in
  -- src/engine/repid-update.ts, which this module does not own. A bond that
  -- READS real but is unenforced is worse than no bond, so it is labelled.
  bond_repid            integer NOT NULL DEFAULT 0,
  bond_enforcement      text NOT NULL DEFAULT 'not_implemented'
                          CHECK (bond_enforcement IN ('not_implemented','recorded','enforced')),
  related_bidder_flag   boolean NOT NULL DEFAULT false,  -- shares identity keys with another BIDDER
  related_to_buyer_flag boolean NOT NULL DEFAULT false,  -- shares identity keys with the BUYER
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT a2a_bids_one_thread_uq  UNIQUE (rfq_id, provider_agent_id),
  CONSTRAINT a2a_bids_no_self_bid_ck CHECK (true)  -- enforced at the route; the buyer id is not on this row
);
CREATE INDEX a2a_bids_rfq_idx      ON public.a2a_bids (rfq_id, status);
CREATE INDEX a2a_bids_provider_idx ON public.a2a_bids (provider_agent_id, created_at DESC);

-- ── 3. a2a_bid_rounds — APPEND-ONLY chain of immutable offers ───────────────
CREATE TABLE public.a2a_bid_rounds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id                uuid NOT NULL REFERENCES public.a2a_bids(id),
  rfq_id                uuid NOT NULL REFERENCES public.a2a_rfqs(id),
  round_no              smallint NOT NULL CHECK (round_no >= 1),
  offered_by            text NOT NULL CHECK (offered_by IN ('provider','buyer')),
  actor_agent_id        uuid NOT NULL REFERENCES public.repid_agents(id),
  price_usdc_raw        bigint NOT NULL CHECK (price_usdc_raw >= 10000),
  eta_seconds           integer NOT NULL CHECK (eta_seconds > 0),
  terms                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepts_round_id      uuid REFERENCES public.a2a_bid_rounds(id),
  -- sha256 over bid_id|round_no|offered_by|actor|price|eta|canonical(terms)|expires_at.
  -- UNKEYED: it detects mutation by anyone WITHOUT write access; it proves
  -- nothing against a writer who can UPDATE the row. Counterparty attestation
  -- is the signature columns below, not this.
  offer_hash            text NOT NULL,
  actor_signature       text,
  actor_signing_address text,
  signature_verified    boolean NOT NULL DEFAULT false,
  attestation_level     text NOT NULL DEFAULT 'server_attested'
                          CHECK (attestation_level IN ('server_attested','counterparty_signed')),
  expires_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT a2a_bid_rounds_seq_uq  CHECK (true),
  CONSTRAINT a2a_bid_rounds_sig_ck  CHECK (attestation_level = 'server_attested' OR signature_verified)
);
CREATE UNIQUE INDEX a2a_bid_rounds_seq_uq_idx ON public.a2a_bid_rounds (bid_id, round_no);
CREATE INDEX a2a_bid_rounds_rfq_idx           ON public.a2a_bid_rounds (rfq_id, created_at);

ALTER TABLE public.a2a_bids
  ADD CONSTRAINT a2a_bids_current_round_fk
  FOREIGN KEY (current_round_id) REFERENCES public.a2a_bid_rounds(id);

-- Append-only becomes a PROPERTY, not a convention. The single writer picks the
-- real role name(s) for this deployment (the engine's role needs INSERT+SELECT
-- only). NOTE HONESTLY: this does not bind the table OWNER.
-- REVOKE UPDATE, DELETE ON public.a2a_bid_rounds FROM <app_role>;

-- ── 4. a2a_awards — the auditable joint between negotiation and contract ────
CREATE TABLE public.a2a_awards (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                               uuid NOT NULL UNIQUE REFERENCES public.a2a_rfqs(id),
  contract_id                          uuid NOT NULL UNIQUE REFERENCES public.service_contracts(id),
  winning_bid_id                       uuid NOT NULL REFERENCES public.a2a_bids(id),
  winning_round_id                     uuid NOT NULL REFERENCES public.a2a_bid_rounds(id),
  buyer_agent_id                       uuid NOT NULL REFERENCES public.repid_agents(id),
  provider_agent_id                    uuid NOT NULL REFERENCES public.repid_agents(id),
  awarded_price_usdc_raw               bigint NOT NULL CHECK (awarded_price_usdc_raw >= 10000),
  promised_eta_seconds                 integer NOT NULL CHECK (promised_eta_seconds > 0),
  base_price_usdc_raw                  bigint,
  underbid_ratio                       numeric,
  was_lowest_price                     boolean NOT NULL,
  is_uncontested                       boolean NOT NULL,
  award_reason_code                    text CHECK (award_reason_code IS NULL OR award_reason_code IN
                                         ('faster_eta','better_delivery_record','scope_fit','sole_eligible_bid',
                                          'risk_concentration','prior_dispute_with_cheaper_bidder','other')),
  award_rationale                      text,
  competing_bid_count                  smallint NOT NULL CHECK (competing_bid_count >= 1),
  decision_snapshot                    jsonb NOT NULL,
  offer_hash_verified                  boolean NOT NULL,
  attestation_level                    text NOT NULL
                                         CHECK (attestation_level IN ('server_attested','counterparty_signed')),
  buyer_provider_related               boolean NOT NULL,
  buyer_provider_prior_awards          integer NOT NULL DEFAULT 0,
  provider_award_share_from_this_buyer numeric,
  awarded_at                           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT a2a_awards_no_self_deal_ck CHECK (buyer_agent_id <> provider_agent_id),
  CONSTRAINT a2a_awards_hash_ck         CHECK (offer_hash_verified),
  -- Awarding anything other than the cheapest valid bid is impossible without a
  -- STRUCTURED code and >= 24 chars of actual explanation, attached forever.
  -- Enforced in Postgres so it survives any future caller that bypasses the router.
  CONSTRAINT a2a_awards_rationale_ck CHECK (
    was_lowest_price
    OR (award_reason_code IS NOT NULL
        AND award_rationale IS NOT NULL
        AND length(btrim(award_rationale)) >= 24)
  ),
  -- An UNCONTESTED award is trivially "lowest", so the rule above never fires
  -- on it — which is exactly the shape a two-agent wash trade takes. Force a
  -- written reason there too.
  CONSTRAINT a2a_awards_uncontested_ck CHECK (
    NOT is_uncontested
    OR (award_reason_code IS NOT NULL
        AND award_rationale IS NOT NULL
        AND length(btrim(award_rationale)) >= 24)
  )
);
CREATE INDEX a2a_awards_provider_idx ON public.a2a_awards (provider_agent_id, awarded_at DESC);
CREATE INDEX a2a_awards_buyer_idx    ON public.a2a_awards (buyer_agent_id, awarded_at DESC);
CREATE INDEX a2a_awards_edge_idx     ON public.a2a_awards (buyer_agent_id, provider_agent_id);

-- ── 5. THE ATOMIC ACCEPT ────────────────────────────────────────────────────
-- PostgREST gives ONE transaction per call. Doing the accept as sequential
-- supabase-js calls lets a rejected a2a_awards CHECK leave a live, payable,
-- un-provenanced service_contract behind — the exact bug this feature exists to
-- remove. So the whole accept is this function, or it does not happen.
--
-- The function does NOT trust the caller's price: it reads price/eta from the
-- referenced round and RAISES if the caller's value disagrees.
CREATE OR REPLACE FUNCTION public.a2a_accept_and_award(
  p_rfq_id                               uuid,
  p_bid_id                               uuid,
  p_round_id                             uuid,
  p_buyer_agent_id                       uuid,
  p_provider_agent_id                    uuid,
  p_service_id                           uuid,
  p_price_usdc_raw                       bigint,
  p_eta_seconds                          integer,
  p_payload                              jsonb,
  p_contract_metadata                    jsonb,
  p_contract_expires_at                  timestamptz,
  p_was_lowest_price                     boolean,
  p_is_uncontested                       boolean,
  p_award_reason_code                    text,
  p_award_rationale                      text,
  p_competing_bid_count                  integer,
  p_decision_snapshot                    jsonb,
  p_offer_hash_verified                  boolean,
  p_base_price_usdc_raw                  bigint,
  p_underbid_ratio                       numeric,
  p_attestation_level                    text,
  p_buyer_provider_related               boolean,
  p_buyer_provider_prior_awards          integer,
  p_provider_award_share_from_this_buyer numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rows        integer;
  v_price       bigint;
  v_eta         integer;
  v_contract_id uuid;
  v_award_id    uuid;
BEGIN
  IF p_buyer_agent_id = p_provider_agent_id THEN
    RAISE EXCEPTION 'a2a_self_dealing_forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- Defence in depth: the router already checks these, but a future caller
  -- must not be able to award a bid that is not on this RFQ.
  PERFORM 1 FROM public.a2a_bids
   WHERE id = p_bid_id
     AND rfq_id = p_rfq_id
     AND provider_agent_id = p_provider_agent_id
     AND service_id = p_service_id
     AND status IN ('open','countered');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a2a_bid_not_awardable' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.a2a_rfqs WHERE id = p_rfq_id AND buyer_agent_id = p_buyer_agent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a2a_buyer_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- THE PRICE COMES FROM THE ROUND. Not from the caller.
  SELECT price_usdc_raw, eta_seconds
    INTO v_price, v_eta
    FROM public.a2a_bid_rounds
   WHERE id = p_round_id AND bid_id = p_bid_id AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a2a_round_not_on_bid_or_expired' USING ERRCODE = 'P0001';
  END IF;
  IF v_price <> p_price_usdc_raw OR v_eta <> p_eta_seconds THEN
    RAISE EXCEPTION 'a2a_price_mismatch: round=% caller=%', v_price, p_price_usdc_raw USING ERRCODE = 'P0001';
  END IF;

  -- Compare-and-swap. A concurrent double-accept yields exactly one contract.
  UPDATE public.a2a_rfqs
     SET status = 'awarded', outcome = 'awarded', closed_at = now()
   WHERE id = p_rfq_id
     AND status IN ('open','closed')
     AND expires_at > now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'a2a_already_awarded_or_expired' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.service_contracts (
    service_id, buyer_agent_id, provider_agent_id,
    agreed_price_usdc_raw, payload, status, expires_at, metadata
  ) VALUES (
    p_service_id, p_buyer_agent_id, p_provider_agent_id,
    v_price, p_payload, 'pending', p_contract_expires_at, p_contract_metadata
  ) RETURNING id INTO v_contract_id;

  -- If any a2a_awards CHECK rejects this row, the contract above is rolled back
  -- with it. That is the entire reason this is one function.
  INSERT INTO public.a2a_awards (
    rfq_id, contract_id, winning_bid_id, winning_round_id,
    buyer_agent_id, provider_agent_id, awarded_price_usdc_raw, promised_eta_seconds,
    base_price_usdc_raw, underbid_ratio, was_lowest_price, is_uncontested,
    award_reason_code, award_rationale, competing_bid_count, decision_snapshot,
    offer_hash_verified, attestation_level, buyer_provider_related,
    buyer_provider_prior_awards, provider_award_share_from_this_buyer
  ) VALUES (
    p_rfq_id, v_contract_id, p_bid_id, p_round_id,
    p_buyer_agent_id, p_provider_agent_id, v_price, v_eta,
    p_base_price_usdc_raw, p_underbid_ratio, p_was_lowest_price, p_is_uncontested,
    p_award_reason_code, p_award_rationale, p_competing_bid_count::smallint, p_decision_snapshot,
    p_offer_hash_verified, p_attestation_level, p_buyer_provider_related,
    p_buyer_provider_prior_awards, p_provider_award_share_from_this_buyer
  ) RETURNING id INTO v_award_id;

  UPDATE public.a2a_bids SET status = 'accepted', updated_at = now() WHERE id = p_bid_id;
  UPDATE public.a2a_bids SET status = 'lost', updated_at = now()
   WHERE rfq_id = p_rfq_id AND id <> p_bid_id AND status IN ('open','countered');

  RETURN jsonb_build_object('contract_id', v_contract_id, 'award_id', v_award_id);
END;
$$;

-- ── 6. RECONCILIATION QUERIES — each MUST return zero rows ──────────────────
-- (a) contract price == award price == winning round price
-- SELECT a.id
--   FROM public.a2a_awards a
--   JOIN public.service_contracts c ON c.id = a.contract_id
--   JOIN public.a2a_bid_rounds  r ON r.id = a.winning_round_id
--  WHERE c.agreed_price_usdc_raw <> a.awarded_price_usdc_raw
--     OR r.price_usdc_raw        <> a.awarded_price_usdc_raw;
--
-- (b) ORPHAN GUARD — a negotiated contract with no award row. This is the
--     escape hatch a non-atomic accept would have created; it must stay empty.
-- SELECT c.id
--   FROM public.service_contracts c
--   LEFT JOIN public.a2a_awards a ON a.contract_id = c.id
--  WHERE c.metadata ? 'negotiation' AND a.id IS NULL;
--
-- (c) party identity agreement across rfq / bid / award / contract
-- SELECT a.id FROM public.a2a_awards a
--   JOIN public.a2a_rfqs f ON f.id = a.rfq_id
--   JOIN public.a2a_bids b ON b.id = a.winning_bid_id
--   JOIN public.service_contracts c ON c.id = a.contract_id
--  WHERE a.buyer_agent_id <> f.buyer_agent_id
--     OR a.buyer_agent_id <> c.buyer_agent_id
--     OR a.provider_agent_id <> b.provider_agent_id
--     OR a.provider_agent_id <> c.provider_agent_id;
--
-- (d) losing bids are never deleted
-- SELECT a.id FROM public.a2a_awards a
--  WHERE (SELECT count(*) FROM public.a2a_bids b
--          WHERE b.rfq_id = a.rfq_id AND b.status = 'lost') <> a.competing_bid_count - 1;
--
-- (e) COLLUSION SURFACE (not a violation — a review queue). Uncontested awards
--     and single-buyer-concentrated providers, ranked.
-- SELECT provider_agent_id,
--        count(*) AS awards,
--        count(*) FILTER (WHERE is_uncontested)          AS uncontested,
--        count(*) FILTER (WHERE buyer_provider_related)  AS related_counterparty,
--        max(provider_award_share_from_this_buyer)       AS max_single_buyer_share
--   FROM public.a2a_awards
--  GROUP BY provider_agent_id
--  ORDER BY uncontested DESC, max_single_buyer_share DESC NULLS LAST;