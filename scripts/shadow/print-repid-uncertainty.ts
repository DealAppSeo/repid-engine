/**
 * print-repid-uncertainty.ts — each agent's RepID next to its uncertainty (Glicko RD). SHADOW.
 *
 *   npx ts-node scripts/shadow/print-repid-uncertainty.ts                         fixtures; no DB, no network
 *   npx ts-node scripts/shadow/print-repid-uncertainty.ts --live                  READ-ONLY: SELECTs only
 *   npx ts-node scripts/shadow/print-repid-uncertainty.ts --live --write-shadow   also appends one row per
 *                                                                                 agent to repid_uncertainty_shadow
 *
 * --live reads repid_agents (id, agent_name, current_repid), settled service_contracts and their
 * x402_settlements, and resolves owners with resolveOwner + ownerRelation (the authoritative TS,
 * not a SQL copy). It needs SUPABASE_URL and a service key (src/config.ts). Without --write-shadow
 * it writes nothing. With it, it appends to repid_uncertainty_shadow ONLY, never repid_agents
 * (supabase/migrations/20261023120000_repid_uncertainty_shadow.sql, which Sean applies).
 *
 * RD is in Glicko points (350 = no checked evidence); RepID is on its own 10-10000 scale. They print
 * side by side, never as "RepID +/- RD": there is no defined map between the scales.
 *
 * Exit: 0 printed; 1 a query or the shadow write failed; 2 NOT_CHECKED, an owner source could not
 * be read, so some agents may read as unknown-owner (and so as uncertain) because the instrument
 * broke, not because the evidence says so.
 *
 * Not a deploy entrypoint. Nothing live imports src/shadow/repid-uncertainty.ts
 * (tests/repid-uncertainty.test.ts proves it).
 */
import {
  C,
  PERIOD_MS,
  RD_FLOOR,
  RD_UNRATED,
  UNCERTAINTY_SCHEMA,
  eventFromSettledContract,
  uncertaintyByAgent,
  type AgentUncertainty,
  type TimedEvent,
} from '../../src/shadow/repid-uncertainty';
import { CASES } from '../../tests/fixtures/antifarming-cases';

const METHOD = `${UNCERTAINTY_SCHEMA} glicko1-rd c=${C.toFixed(2)} period=${PERIOD_MS / 86_400_000}d floor=${RD_FLOOR} unrated=${RD_UNRATED}`;
const iso = (t: number | null) => (t === null ? '-' : new Date(t).toISOString().slice(0, 10));

function table(rows: Array<{ name: string; repid: string; u: AgentUncertainty | undefined }>): string {
  const head = '| agent | RepID (read, unchanged) | RD | RD/350 | checked | not counted | last checked |\n|---|---|---|---|---|---|---|';
  return [head, ...rows.map(({ name, repid, u }) => {
    const rd = u?.rd ?? RD_UNRATED;
    return `| ${name} | ${repid} | ${rd.toFixed(1)} | ${Math.round((100 * rd) / RD_UNRATED)}% | ${u?.checked_outcomes ?? 0} | ${u?.not_counted ?? 0} | ${iso(u?.last_checked_at ?? null)} |`;
  })].join('\n');
}

function fixtures(): void {
  const now = Date.UTC(2026, 0, 1);
  const rows = CASES.map((c) => {
    const actor = c.events.find((e) => e.event_id === c.subject)?.actor_id ?? '?';
    return { name: `${c.kind}: ${c.name} (${actor})`, repid: 'n/a', u: uncertaintyByAgent(c.events.map((event) => ({ at: now, event })), now).get(actor) };
  });
  console.log(`REPID UNCERTAINTY (shadow, fixtures) — ${METHOD}\n${table(rows)}`);
}

async function live(writeShadow: boolean): Promise<number> {
  // Loaded here so fixture mode needs no environment: src/config.ts throws without SUPABASE_URL.
  const { db } = require('../../src/db') as typeof import('../../src/db');
  const { resolveOwner } = require('../../src/services/agent-owner-resolver') as typeof import('../../src/services/agent-owner-resolver');
  const { ownerRelation } = require('../../src/services/owner-distinct-shadow') as typeof import('../../src/services/owner-distinct-shadow');
  const asOf = Date.now();

  type Contract = { id: string; buyer_agent_id: string; provider_agent_id: string; settled_at: string | null };
  const contracts: Array<Contract & { settled_at: string }> = [];
  let undated = 0; // an outcome with no time cannot be placed in a period: not evidence
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('service_contracts')
      .select('id, buyer_agent_id, provider_agent_id, settled_at')
      .eq('status', 'settled').order('id').range(from, from + 999);
    if (error) throw new Error(`service_contracts: ${error.message}`);
    for (const c of (data ?? []) as Contract[]) {
      if (c.settled_at) contracts.push({ ...c, settled_at: c.settled_at });
      else undated++;
    }
    if ((data ?? []).length < 1000) break;
  }

  const ids = contracts.map((c) => c.id);
  const settlements = new Map<string, Array<{ status: string | null; is_simulated: boolean | null }>>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('x402_settlements').select('idempotency_key, status, is_simulated').in('idempotency_key', ids.slice(i, i + 200));
    if (error) throw new Error(`x402_settlements: ${error.message}`);
    for (const s of data ?? []) settlements.set(String(s.idempotency_key), [...(settlements.get(String(s.idempotency_key)) ?? []), s]);
  }

  const agentIds = [...new Set(contracts.flatMap((c) => [c.provider_agent_id, c.buyer_agent_id]))];
  const owners = new Map<string, Awaited<ReturnType<typeof resolveOwner>>>();
  for (const id of agentIds) owners.set(id, await resolveOwner({ id }));
  // A source that could not be read leaves an owner unknown for a reason that is not evidence.
  const unread = new Map<string, number>();
  for (const r of owners.values()) {
    const reasons = r.probes.flatMap((p) => (p.status === 'indeterminate' ? [p.reason] : []));
    if (r.probes.length === 0 && r.reason) reasons.push(r.reason);
    for (const why of reasons) unread.set(why, (unread.get(why) ?? 0) + 1);
  }

  const relations = new Map<string, number>();
  const events: TimedEvent[] = contracts.map((c) => {
    const link = ownerRelation(owners.get(c.provider_agent_id)!, owners.get(c.buyer_agent_id)!);
    relations.set(`${link.relation}/${link.evidence}`, (relations.get(`${link.relation}/${link.evidence}`) ?? 0) + 1);
    return { at: Date.parse(c.settled_at), event: eventFromSettledContract(c, link, settlements.get(c.id) ?? []) };
  });
  const byAgent = uncertaintyByAgent(events, asOf);

  const agents: Array<{ id: string; agent_name: string; current_repid: number | null }> = [];
  for (let i = 0; i < agentIds.length; i += 200) {
    const { data, error } = await db.from('repid_agents').select('id, agent_name, current_repid').in('id', agentIds.slice(i, i + 200));
    if (error) throw new Error(`repid_agents: ${error.message}`);
    agents.push(...((data ?? []) as typeof agents));
  }
  const { count: total, error: countErr } = await db.from('repid_agents').select('id', { count: 'exact', head: true });
  if (countErr) throw new Error(`repid_agents count: ${countErr.message}`);

  const rows = agents
    .map((a) => ({ a, u: byAgent.get(a.id) }))
    .sort((x, y) => (y.u?.checked_outcomes ?? 0) - (x.u?.checked_outcomes ?? 0) || x.a.agent_name.localeCompare(y.a.agent_name));
  console.log(`REPID UNCERTAINTY (shadow, live, read-only) as of ${new Date(asOf).toISOString()} — ${METHOD}`);
  console.log(table(rows.map(({ a, u }) => ({ name: a.agent_name, repid: String(a.current_repid ?? '-'), u }))));
  console.log(`\nsettled contracts: ${contracts.length} (+${undated} with no settled_at, not counted); owner relation/evidence: ${JSON.stringify(Object.fromEntries(relations))}`);
  console.log(`agents in settled trades: ${agents.length}, with >= 1 checked outcome: ${rows.filter((r) => (r.u?.checked_outcomes ?? 0) > 0).length}; ` +
    `${(total ?? 0) - agents.length} other agents have no settled trade, so RD ${RD_UNRATED}.`);

  if (writeShadow) {
    const { error } = await db.from('repid_uncertainty_shadow').insert(rows.map(({ a, u }) => ({
      agent_id: a.id, as_of: new Date(asOf).toISOString(), rd: u?.rd ?? RD_UNRATED, checked_outcomes: u?.checked_outcomes ?? 0,
      not_counted: u?.not_counted ?? 0, last_checked_at: u?.last_checked_at ? new Date(u.last_checked_at).toISOString() : null,
      repid_at_compute: a.current_repid, method: METHOD,
    })));
    if (error) { console.error(`repid_uncertainty_shadow insert FAILED: ${error.message}`); return 1; }
    console.log(`wrote ${rows.length} rows to repid_uncertainty_shadow (shadow table; repid_agents untouched)`);
  }
  if (unread.size > 0) {
    console.error(`NOT_CHECKED: owner sources that could not be read: ${JSON.stringify(Object.fromEntries(unread))}. ` +
      'Those agents may read as unknown-owner, and so as uncertain, because a lookup failed rather than because of the evidence.');
    return 2;
  }
  return 0;
}

const args = process.argv.slice(2);
if (args.includes('--write-shadow') && !args.includes('--live')) { console.error('--write-shadow needs --live'); process.exit(1); }
if (!args.includes('--live')) fixtures();
else live(args.includes('--write-shadow')).then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });
