-- Rollback for 20261116180000_hal_score_gate_shadow.sql. Drops a measurement table nothing scores from.
-- Set HAL_SCORE_GATE_MODE=off (or unset it) first, or shadow mode will log that the table is missing.
drop table if exists public.hal_score_gate_shadow;
