-- Add missing column to trinity_heartbeat to support the V4 agent schema
ALTER TABLE trinity_heartbeat
ADD COLUMN IF NOT EXISTS current_task_summary TEXT;
