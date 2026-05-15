DO $$
DECLARE
    constraint_record RECORD;
BEGIN
    FOR constraint_record IN
        SELECT conname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'trinity_tasks' AND a.attname = 'status' AND c.contype = 'c'
    LOOP
        EXECUTE 'ALTER TABLE trinity_tasks DROP CONSTRAINT IF EXISTS ' || quote_ident(constraint_record.conname);
    END LOOP;

    -- Add the new constraint with extended statuses
    ALTER TABLE trinity_tasks ADD CONSTRAINT trinity_tasks_status_check
        CHECK (status IN ('pending', 'in_progress', 'doing', 'completed', 'done', 'failed', 'cancelled', 'archived', 'verified', 'pending_validation', 'shadow_reject', 'pending_clarification'));
END $$;
