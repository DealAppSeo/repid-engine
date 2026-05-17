export interface ServiceContractRow {
  id: string;
  provider_agent_id: string;
  buyer_agent_id: string;
  payload: Record<string, any>;
  result?: Record<string, any>;
  status: string;
  // Phase 2.10 additive (optional → non-breaking for Phase 2.11 handlers
  // which only read id/payload/buyer_agent_id/provider_agent_id):
  service_id?: string;
  metadata?: Record<string, any> | null;
  created_at?: string;
  fulfilled_at?: string;
}
