-- Atomic append function for hal_audit_chain.
-- Acquires a transaction-scoped advisory lock so concurrent appends serialize:
-- each caller observes the true last current_entry_hash before inserting.
-- Hash formula: SHA256( coalesce(prev_hash,'') || canonical_json_text || source_table || source_id ).
-- The canonical JSON text is supplied by the caller (client-side canonicalization
-- with sorted object keys) so that the application-side verify walk can
-- reproduce the exact input string by re-canonicalizing event_payload.

CREATE OR REPLACE FUNCTION append_hal_audit_chain(
  p_source_table TEXT,
  p_source_id TEXT,
  p_event_payload JSONB,
  p_canonical_json_text TEXT
) RETURNS TABLE(id BIGINT, current_entry_hash TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash TEXT;
  v_new_hash TEXT;
  v_new_id BIGINT;
BEGIN
  -- Serialize concurrent appenders on this chain. hashtext() fits in int4.
  PERFORM pg_advisory_xact_lock(hashtext('hal_audit_chain_append'));

  SELECT hac.current_entry_hash
    INTO v_prev_hash
    FROM hal_audit_chain hac
    ORDER BY hac.id DESC
    LIMIT 1;

  v_new_hash := encode(
    digest(
      coalesce(v_prev_hash, '') || p_canonical_json_text || p_source_table || p_source_id,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO hal_audit_chain(
    source_table, source_id, event_payload, previous_entry_hash, current_entry_hash
  ) VALUES (
    p_source_table, p_source_id, p_event_payload, v_prev_hash, v_new_hash
  )
  RETURNING hal_audit_chain.id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, v_new_hash;
END;
$$;
