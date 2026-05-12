ALTER TABLE repid_events DROP CONSTRAINT IF EXISTS repid_events_event_type_check;
ALTER TABLE repid_events ADD CONSTRAINT repid_events_event_type_check 
CHECK (event_type = ANY (ARRAY[
  'task_complete', 'task_fail', 'artifact_create', 'peer_validate', 'peer_reject', 
  'consensus_participate', 'discovery_new_provider', 'exploration_success', 'exploration_fail',
  'x402_inbound_settled', 'x402_outbound_settled'
]));
