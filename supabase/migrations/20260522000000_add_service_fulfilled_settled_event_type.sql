-- Migration to allow service_fulfilled_settled event type in repid_events
ALTER TABLE repid_events DROP CONSTRAINT IF EXISTS repid_events_event_type_check;

ALTER TABLE repid_events ADD CONSTRAINT repid_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'task_complete'::text,
    'task_fail'::text,
    'artifact_create'::text,
    'peer_validate'::text,
    'peer_reject'::text,
    'consensus_participate'::text,
    'discovery_new_provider'::text,
    'exploration_success'::text,
    'exploration_fail'::text,
    'x402_inbound_settled'::text,
    'x402_outbound_settled'::text,
    'service_fulfilled_settled'::text
  ]));
