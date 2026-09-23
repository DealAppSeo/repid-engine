export interface PeerVerificationQueueEntry {
  id: number | string;
  source_response_id: string;
  source_agent_id: string;
  certainty_at_claim: number;
  verification_status: string;
  claim_text: string | null;
  threshold_used?: number;
  verifier_agent_id?: string | null;
  verifier_response_id?: string | null;
  verifier_signature?: string | null;
  created_at?: string;
  completed_at?: string | null;
  /**
   * How many times this row's expired lease has been RECLAIMED. Not a retry count
   * for the verification itself — it counts only reclaims, so a first claim leaves
   * it at 0.
   *
   * It exists because the gate that stops the reclaim loop (breaker 2.4) turns on
   * one env var being false. This is the bound that holds if someone enables the
   * panel before the verdict path is proven: past PEER_VERIFY_RECLAIM_CAP the row
   * is closed rather than recycled, so the worst case is finite.
   */
  reclaim_count?: number;

  /**
   * When verification_status last moved to in_review. NULL on every row claimed
   * before 2026-09-22, which is exactly why the reclaim predicate
   * (claimed_at < now() - ttl) cannot match the 62,841 legacy wedged rows.
   */
  claimed_at?: string | null;
  /** Why a row was closed without a verdict, e.g. recursive_meta_verification. */
  closure_reason?: string | null;
}
