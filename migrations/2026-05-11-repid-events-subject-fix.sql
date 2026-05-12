ALTER TABLE repid_events DROP CONSTRAINT IF EXISTS repid_events_subject_type_check;
ALTER TABLE repid_events ADD CONSTRAINT repid_events_subject_type_check 
CHECK (subject_type = ANY (ARRAY['conductor', 'user', 'provider', 'agent']));
