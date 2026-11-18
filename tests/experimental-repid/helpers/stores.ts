/**
 * Two ExperimentalStore implementations for settlement tests.
 *
 * memoryStore  emulates the migration's two unique indexes and the score_after chain. insert() checks and
 *              appends in ONE synchronous step, as the database does inside one statement, so two overlapping
 *              async callers cannot both pass the check.
 * pgStore      the real thing: applies supabase/migrations/20261102140000_repid_experimental_events.sql to a
 *              FRESH database on a throwaway Postgres (EXP_REPID_PG_URL), with a stub repid_agents. It never
 *              connects anywhere else; the URL must point at a loopback host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { AgentRow, ExperimentalEventRow, ExperimentalStore } from '../../../src/services/experimental-repid';

export interface StoredEvent extends ExperimentalEventRow { id: number; score_after: number }

export function memoryStore(agents: AgentRow[]) {
  const events: StoredEvent[] = [];
  const store: ExperimentalStore = {
    async getAgent(id) {
      return agents.find((a) => a.id === id) ?? null;
    },
    async insert(row) {
      const clash = events.some((r) => r.domain === row.domain && r.dimension === row.dimension && r.mode === row.mode &&
        (r.evidence_id === row.evidence_id || r.evidence_hash === row.evidence_hash));
      if (clash) return { ok: false, duplicate: true, error: 'duplicate key value violates unique constraint' };
      const prev = events.filter((r) => r.domain === row.domain && r.agent_id === row.agent_id && r.dimension === row.dimension && r.mode === row.mode);
      const score_after = (prev.length ? prev[prev.length - 1]!.score_after : 0) + row.delta;
      events.push({ ...row, id: events.length + 1, score_after });
      return { ok: true, score_after };
    },
  };
  return { store, events };
}

export const PG_URL = process.env.EXP_REPID_PG_URL;

const MIGRATION = join(__dirname, '../../../supabase/migrations/20261102140000_repid_experimental_events.sql');

/** Create a fresh database on the throwaway server, apply the real migration, seed agents. */
export async function freshPgDatabase(agents: AgentRow[]): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!PG_URL) throw new Error('EXP_REPID_PG_URL is not set');
  const host = new URL(PG_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`refusing non-loopback EXP_REPID_PG_URL host ${host}`);
  const name = `exp_repid_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`create database ${name}`);
  const u = new URL(PG_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const p = new Pool({ connectionString: url, max: 1 });
  for (const r of ['anon', 'authenticated', 'service_role']) {
    await p.query(`do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`);
  }
  await p.query('create table public.repid_agents (id uuid primary key, agent_id text, agent_name text)');
  for (const a of agents) await p.query('insert into public.repid_agents (id, agent_id, agent_name) values ($1, $2, $3)', [a.id, a.agent_id, a.agent_name]);
  await p.query(readFileSync(MIGRATION, 'utf8'));
  await p.end();
  return {
    url,
    drop: async () => {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/** A real store over one connection pool. Each ExperimentalStore call is its own autocommit statement. */
export function pgStore(url: string) {
  const pool = new Pool({ connectionString: url, max: 4 });
  const store: ExperimentalStore = {
    async getAgent(id) {
      const r = await pool.query('select id::text as id, agent_id, agent_name from public.repid_agents where id::text = $1', [id]);
      return (r.rows[0] as AgentRow | undefined) ?? null;
    },
    async insert(row) {
      try {
        const r = await pool.query(
          `insert into public.repid_experimental_events
             (domain, agent_id, dimension, evidence_kind, evidence_id, evidence_ref, evidence_hash, oracle_id,
              counterparty_agent_id, eligibility, scoring_version, mode, delta, score_after, metadata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, 0, $14) returning score_after`,
          [row.domain, row.agent_id, row.dimension, row.evidence_kind, row.evidence_id, row.evidence_ref, row.evidence_hash, row.oracle_id,
            row.counterparty_agent_id, row.eligibility, row.scoring_version, row.mode, row.delta, JSON.stringify(row.metadata)],
        );
        return { ok: true, score_after: Number(r.rows[0].score_after) };
      } catch (err) {
        const e = err as { code?: string; message: string };
        return { ok: false, duplicate: e.code === '23505', error: e.message };
      }
    },
  };
  return { store, pool };
}
