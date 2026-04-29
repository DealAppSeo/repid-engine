/**
 * Two-agent trader — APM (trader) and VERITAS (verifier/counterparty).
 *
 * A "trading round" pairs a sports oracle outcome with two linked
 * bets: APM bets one direction, VERITAS bets the opposite (or
 * concurrent same direction; both are scored against the eventual
 * oracle outcome).
 *
 * This service supplies the scaffolding around placeBet/resolveBet:
 *   - mock sports oracle (deterministic; flag is_simulated)
 *   - APM/VERITAS prediction generators (mock)
 *   - x402 tip request between the two
 *   - resolveOpenRounds() worker, runs on cron or manual trigger
 *
 * The mock pieces are clearly marked. v0.2 wires real sports-data
 * providers + HAL-validated prediction text.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { placeBet, resolveBet, signOracleOutcome } from './linked-bet-resolver';

export const APM_AGENT_NAME = 'APM';
export const VERITAS_AGENT_NAME = 'VERITAS';

interface AgentRow {
  id: string;
  name: string;
  current_repid: number;
}

async function getFleetAgent(name: string): Promise<AgentRow | null> {
  const { data } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid')
    .eq('agent_name', name)
    .maybeSingle();
  if (!data) return null;
  return { id: data.id, name: data.agent_name, current_repid: Number(data.current_repid) };
}

// Mock upcoming-game oracle. Deterministic by day so a demo run is
// reproducible. v0.2 wraps a real sports API (fetch_sports_data).
export interface UpcomingGame {
  id: string;
  league: 'nba';
  home_team: string;
  away_team: string;
  start_time_ms: number;
  is_simulated: boolean;
}

function dailySeed(): number {
  const today = new Date().toISOString().slice(0, 10);
  let h = 0;
  for (const c of today) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function fetchUpcomingGame(_league: 'nba'): UpcomingGame {
  const teams = ['Lakers', 'Celtics', 'Warriors', 'Knicks', 'Bucks', 'Nuggets'];
  const seed = dailySeed();
  const home = teams[seed % teams.length] ?? teams[0]!;
  const awayCandidates = teams.filter(t => t !== home);
  const away = awayCandidates[seed % awayCandidates.length] ?? awayCandidates[0]!;
  // Schedule 1h from now so resolveOpenRounds can pick it up later.
  const start = Date.now() + 60 * 60 * 1000;
  return {
    id: `nba-mock-${seed.toString(16)}`,
    league: 'nba',
    home_team: home,
    away_team: away,
    start_time_ms: start,
    is_simulated: true,
  };
}

interface AgentPrediction {
  predicted_winner: 'home' | 'away';
  claimed_confidence: number;        // basis points
  reasoning: string;
}

export function generateApmPrediction(game: UpcomingGame): AgentPrediction {
  // Mock: APM picks home, claims modest confidence.
  return {
    predicted_winner: 'home',
    claimed_confidence: 6500,
    reasoning: `[mock] APM analyzes ${game.home_team} home advantage and recent form.`,
  };
}

export function generateVeritasPrediction(game: UpcomingGame, _apmPrediction: AgentPrediction): AgentPrediction {
  // Mock: VERITAS picks the opposite, slightly less confident.
  return {
    predicted_winner: 'away',
    claimed_confidence: 5500,
    reasoning: `[mock] VERITAS counter-models ${game.away_team} as undervalued.`,
  };
}

export function computeTipPrice(claimedConfidenceBp: number): bigint {
  // Tip price scales with confidence. 5000bp ⇒ 1.5 USDC; 9000bp ⇒ 1.9 USDC.
  const base = 1_000_000n;
  const confidenceFactor = BigInt(Math.max(0, Math.min(10000, claimedConfidenceBp)));
  return base + (confidenceFactor * 100n);
}

// Mock oracle outcome. Deterministic per game id so resolution is
// reproducible across runs.
export function fetchOracleOutcome(gameId: string): boolean | null {
  // Time-gate: only return an outcome once the game's "expected resolution"
  // window has elapsed. The trader-runner schedules this; for the demo
  // endpoint we let the caller choose to ignore the gate.
  let h = 0;
  for (const c of gameId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 === 0;
}

// ---------------------------------------------------------------------------
// Trading round orchestration
// ---------------------------------------------------------------------------

export interface StartRoundResult {
  ok: boolean;
  round_id: string | null;
  apm_bet: string | null;
  veritas_bet: string | null;
  game: UpcomingGame | null;
  is_simulated: boolean;
  error?: string;
}

export async function startTradingRound(opts: { betAmountOverride?: bigint, demoBuilderId?: string } = {}): Promise<StartRoundResult> {
  const apm = await getFleetAgent(APM_AGENT_NAME);
  const veritas = await getFleetAgent(VERITAS_AGENT_NAME);
  if (!apm || !veritas) {
    return { ok: false, round_id: null, apm_bet: null, veritas_bet: null, game: null, is_simulated: true, error: 'APM or VERITAS not seeded' };
  }

  const game = fetchUpcomingGame('nba');
  const apmPrediction = generateApmPrediction(game);
  const veritasPrediction = generateVeritasPrediction(game, apmPrediction);

  const tipPrice = opts.betAmountOverride ?? computeTipPrice(apmPrediction.claimed_confidence);
  const expectedRes = new Date(game.start_time_ms + 4 * 60 * 60 * 1000);   // +4h after start
  const roundId = `round_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Place both bets. Per atomic-linkage rules, each bet records its
  // counterparty_repid in the prediction payload so character events
  // can fire on resolve.
  let apmBet: string | null = null;
  let veritasBet: string | null = null;
  try {
    const a = await placeBet({
      agentId: apm.id,
      betAmount: tipPrice,
      claimedConfidence: apmPrediction.claimed_confidence,
      predictionPayload: {
        game,
        predicted_outcome: apmPrediction.predicted_winner === 'home',
        counterparty_repid: veritas.current_repid,
        reasoning: apmPrediction.reasoning,
      },
      oracleEndpoint: `sports/${game.id}`,
      expectedResolutionTime: expectedRes,
      demoBuilderId: opts.demoBuilderId,
    });
    apmBet = a.betId;

    const v = await placeBet({
      agentId: veritas.id,
      betAmount: tipPrice,
      claimedConfidence: veritasPrediction.claimed_confidence,
      predictionPayload: {
        game,
        predicted_outcome: veritasPrediction.predicted_winner === 'home',
        counterparty_repid: apm.current_repid,
        reasoning: veritasPrediction.reasoning,
      },
      oracleEndpoint: `sports/${game.id}`,
      expectedResolutionTime: expectedRes,
      demoBuilderId: opts.demoBuilderId,
    });
    veritasBet = v.betId;
  } catch (e: any) {
    return { ok: false, round_id: null, apm_bet: apmBet, veritas_bet: veritasBet, game, is_simulated: true, error: e?.message ?? 'place failed' };
  }

  await db.from('trading_rounds').insert({
    id: roundId,
    apm_bet_id: apmBet,
    veritas_bet_id: veritasBet,
    expected_resolution: expectedRes.toISOString(),
    status: 'open',
  });

  await emitAuditEvent({
    event_type: 'round_started',
    source_table: 'trading_rounds',
    source_id: roundId,
    payload: {
      round_id: roundId,
      apm_bet: apmBet,
      veritas_bet: veritasBet,
      game_id: game.id,
      expected_resolution: expectedRes.toISOString(),
      is_simulated: true,
    },
  });

  return { ok: true, round_id: roundId, apm_bet: apmBet, veritas_bet: veritasBet, game, is_simulated: true };
}

export interface ResolveRoundsResult {
  resolved: number;
  details: Array<{ round_id: string; apm_outcome: any; veritas_outcome: any }>;
}

export async function resolveOpenRounds(opts: { force?: boolean } = {}): Promise<ResolveRoundsResult> {
  const cutoff = opts.force ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : new Date().toISOString();
  const { data: open } = await db
    .from('trading_rounds')
    .select('*')
    .eq('status', 'open')
    .lte('expected_resolution', cutoff);

  const details: ResolveRoundsResult['details'] = [];
  for (const round of open ?? []) {
    const { data: bet } = await db.from('linked_bets').select('prediction_payload').eq('id', round.apm_bet_id).maybeSingle();
    const game = (bet?.prediction_payload as any)?.game;
    if (!game?.id) continue;

    const oracleOutcome = fetchOracleOutcome(game.id);
    if (oracleOutcome === null) continue;

    const sigA = signOracleOutcome(round.apm_bet_id, oracleOutcome);
    const sigV = signOracleOutcome(round.veritas_bet_id, oracleOutcome);
    const apmR = await resolveBet(round.apm_bet_id, oracleOutcome, sigA);
    const veritasR = await resolveBet(round.veritas_bet_id, oracleOutcome, sigV);

    await db.from('trading_rounds').update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_outcome: oracleOutcome,
    }).eq('id', round.id);

    details.push({ round_id: round.id, apm_outcome: apmR, veritas_outcome: veritasR });
  }
  return { resolved: details.length, details };
}

export async function getTraderState(): Promise<{
  apm: AgentRow | null;
  veritas: AgentRow | null;
  open_rounds: any[];
  recent_resolved: any[];
}> {
  const apm = await getFleetAgent(APM_AGENT_NAME);
  const veritas = await getFleetAgent(VERITAS_AGENT_NAME);
  const { data: open } = await db.from('trading_rounds').select('*').eq('status', 'open').order('started_at', { ascending: false }).limit(20);
  const { data: recent } = await db.from('trading_rounds').select('*').eq('status', 'resolved').order('resolved_at', { ascending: false }).limit(20);
  return { apm, veritas, open_rounds: open ?? [], recent_resolved: recent ?? [] };
}
