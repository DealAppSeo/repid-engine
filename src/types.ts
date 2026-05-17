export interface ServiceContractRow {
  id: string;
  provider_agent_id: string;
  buyer_agent_id: string;
  payload: Record<string, any>;
  result?: Record<string, any>;
  status: string;
}
