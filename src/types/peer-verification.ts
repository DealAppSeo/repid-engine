export interface PeerVerificationQueueEntry {
  id: string;
  source_response_id: string;
  source_agent_id: string;
  certainty_at_claim: number;
  verification_status: 'pending' | 'in_review' | 'verified' | 'disputed' | 'timeout';
  verifier_agent_id: string | null;
  verifier_response_id: string | null;
  verifier_signature: string | null;
  created_at: string;
  completed_at: string | null;
  threshold_used: number;
  claim_text: string | null;
}

export type VerifierVerdict = 'verified' | 'disputed' | 'timeout';
