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
}
