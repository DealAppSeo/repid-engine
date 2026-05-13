/**
 * Shared types + helpers for CC Sprint 9 liveness probes.
 *
 * Each probe returns a ProbeResult. The status enum is:
 *   GREEN  — feature is actively working (≥1 row in last 1h)
 *   AMBER  — feature was working in last 24h but quiet in last 1h
 *   RED    — feature has no activity in last 24h
 *
 * Probes are READ-ONLY against production. They do not modify any
 * table other than the dedicated `liveness_probe_history` table
 * (which is metadata-only, written by `run-all-probes.ts`).
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export type ProbeStatus = 'GREEN' | 'AMBER' | 'RED';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  metrics: Record<string, any>;
  message?: string;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _client: SupabaseClient | null = null;
export function getDb(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  }
  return _client;
}

/**
 * Standard 1h/24h-bucket → GREEN/AMBER/RED classifier.
 * Caller passes counts already computed.
 */
export function classifyByActivity(count1h: number, count24h: number): ProbeStatus {
  if (count1h >= 1) return 'GREEN';
  if (count24h >= 1) return 'AMBER';
  return 'RED';
}

export const STATUS_COLOR: Record<ProbeStatus, string> = {
  GREEN: '\x1b[32m',
  AMBER: '\x1b[33m',
  RED: '\x1b[31m',
};
export const RESET = '\x1b[0m';

export function formatRow(result: ProbeResult): string {
  const color = STATUS_COLOR[result.status];
  return `${color}${result.status.padEnd(5)}${RESET}  ${result.name}`;
}
