interface Agent { agentId: string; displayName: string; repidScore: number; }
interface User { userId: string; displayName: string; }
interface Stake { stakeId: string; userId: string; agentId: string; amountUSD: number; status: 'active' | 'withdrawn'; createdAt: string; withdrawnAt?: string; }
interface TradeAttempt { attemptId: string; agentId: string; userId: string; tradeSizeUSD: number; repidAtDecision: number; fractionUsed: number; totalStakeBackingUSD: number; maxAllowedUSD: number; decision: 'approved' | 'rejected_size' | 'rejected_no_stake' | 'rejected_repid_too_low'; reason: string; createdAt: string; }

const state = { users: new Map<string, User>(), agents: new Map<string, Agent>(), stakes: [] as Stake[], tradeAttempts: [] as TradeAttempt[] };

const REPID_TIERS = [
  { min: 0, max: 0, fraction: 0.00, label: 'banned' },
  { min: 1, max: 99, fraction: 0.01, label: 'toy' },
  { min: 100, max: 999, fraction: 0.05, label: 'new' },
  { min: 1000, max: 2999, fraction: 0.10, label: 'established' },
  { min: 3000, max: 4999, fraction: 0.20, label: 'trusted' },
  { min: 5000, max: 6999, fraction: 0.35, label: 'proven' },
  { min: 7000, max: 8499, fraction: 0.50, label: 'senior' },
  { min: 8500, max: 9499, fraction: 0.70, label: 'expert' },
  { min: 9500, max: 9999, fraction: 0.85, label: 'elite' },
  { min: 10000, max: Infinity, fraction: 1.00, label: 'autonomous-cap' },
];

function fractionForRepID(repid: number) {
  const r = Math.floor(repid);
  const tier = REPID_TIERS.find(t => r >= t.min && r <= t.max)!;
  return { fraction: tier.fraction, label: tier.label };
}

function createUser(name: string): User {
  const u: User = { userId: `user-${name}-${Date.now()}`, displayName: name };
  state.users.set(u.userId, u);
  return u;
}

function seedAgents() {
  [
    { agentId: 'sophia', displayName: 'SOPHIA', repidScore: 10000 },
    { agentId: 'veritas', displayName: 'VERITAS', repidScore: 8500 },
    { agentId: 'hdm', displayName: 'HDM', repidScore: 7200 },
    { agentId: 'test-newbie', displayName: 'Test-Newbie', repidScore: 100 },
    { agentId: 'banned-bot', displayName: 'Banned-Bot', repidScore: 0 },
  ].forEach(a => state.agents.set(a.agentId, a));
}

function stakeAndBind(userId: string, agentId: string, amountUSD: number): Stake {
  if (amountUSD <= 0) throw new Error('amount must be positive');
  if (!state.users.has(userId)) throw new Error('unknown user');
  if (!state.agents.has(agentId)) throw new Error('unknown agent');
  const s: Stake = { stakeId: `stake-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, userId, agentId, amountUSD, status: 'active', createdAt: new Date().toISOString() };
  state.stakes.push(s);
  return s;
}

function withdrawStake(stakeId: string) {
  const s = state.stakes.find(x => x.stakeId === stakeId);
  if (!s) throw new Error('unknown stake');
  s.status = 'withdrawn';
  s.withdrawnAt = new Date().toISOString();
}

function getUserPosition(userId: string) {
  const user = state.users.get(userId)!;
  const active = state.stakes.filter(s => s.userId === userId && s.status === 'active');
  const stakes = active.map(stake => {
    const agent = state.agents.get(stake.agentId)!;
    const { fraction, label } = fractionForRepID(agent.repidScore);
    return { stake, agent, fraction, label, maxAllowedTradeUSD: stake.amountUSD * fraction };
  });
  return { user, stakes, totalActiveStakeUSD: active.reduce((sum, s) => sum + s.amountUSD, 0) };
}

function decideTrade(input: { agentId: string; tradeSizeUSD: number; userId?: string }): TradeAttempt {
  const agent = state.agents.get(input.agentId)!;
  const { fraction } = fractionForRepID(agent.repidScore);
  const backing = state.stakes.filter(s => s.agentId === input.agentId && s.status === 'active' && (input.userId === undefined || s.userId === input.userId));
  const totalBacking = backing.reduce((sum, s) => sum + s.amountUSD, 0);
  const userId = input.userId ?? backing[0]?.userId ?? 'no-user';
  const maxAllowed = totalBacking * fraction;
  let decision: TradeAttempt['decision'];
  let reason: string;
  if (agent.repidScore <= 0) { decision = 'rejected_repid_too_low'; reason = `RepID ${agent.repidScore} at-or-below floor`; }
  else if (totalBacking <= 0) { decision = 'rejected_no_stake'; reason = `No active stakes backing ${agent.agentId}`; }
  else if (input.tradeSizeUSD > maxAllowed) { decision = 'rejected_size'; reason = `$${input.tradeSizeUSD} exceeds max $${maxAllowed.toFixed(2)} (${(fraction*100).toFixed(0)}% of $${totalBacking})`; }
  else { decision = 'approved'; reason = `$${input.tradeSizeUSD} within max $${maxAllowed.toFixed(2)} (${(fraction*100).toFixed(0)}% of $${totalBacking})`; }
  const attempt: TradeAttempt = { attemptId: `att-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, agentId: input.agentId, userId, tradeSizeUSD: input.tradeSizeUSD, repidAtDecision: agent.repidScore, fractionUsed: fraction, totalStakeBackingUSD: totalBacking, maxAllowedUSD: maxAllowed, decision, reason, createdAt: new Date().toISOString() };
  state.tradeAttempts.push(attempt);
  return attempt;
}

function header(n: number, t: string) { console.log('\n' + '='.repeat(72) + `\nSTEP ${n}: ${t}\n` + '='.repeat(72)); }
function showPos(uid: string) { const p = getUserPosition(uid); console.log(`\n  ${p.user.displayName} | total: $${p.totalActiveStakeUSD}`); if (p.stakes.length === 0) console.log('  (no active stakes)'); else p.stakes.forEach(s => console.log(`  -> ${s.agent.displayName.padEnd(12)} | RepID ${String(s.agent.repidScore).padEnd(6)} | tier "${s.label}" | ${(s.fraction*100).toFixed(0)}% | stake $${s.stake.amountUSD} | max $${s.maxAllowedTradeUSD}`)); }
function showAtt(a: TradeAttempt) { const tag = a.decision === 'approved' ? '[APPROVED]' : `[${a.decision.toUpperCase()}]`; console.log(`  ${tag}: ${a.reason}`); }

console.log('\nRepID Weighted Staking - Local MVP Demo\n========================================');
seedAgents();

header(1, 'Create user "alice"');
const alice = createUser('alice');
console.log(`  Created: ${alice.userId}`);

header(2, 'Show alice position (empty)');
showPos(alice.userId);

header(3, 'Alice stakes $1000 to SOPHIA (RepID 10000, 100% fraction)');
const sStake = stakeAndBind(alice.userId, 'sophia', 1000);
console.log(`  Created: ${sStake.stakeId}`);

header(4, 'Show alice position');
showPos(alice.userId);

header(5, 'SOPHIA attempts $500 (should APPROVE)');
showAtt(decideTrade({ agentId: 'sophia', tradeSizeUSD: 500 }));

header(6, 'SOPHIA attempts $1500 (should REJECT)');
showAtt(decideTrade({ agentId: 'sophia', tradeSizeUSD: 1500 }));

header(7, 'Alice stakes $500 to test-newbie (RepID 100, 5% fraction, max $25)');
const nStake = stakeAndBind(alice.userId, 'test-newbie', 500);
console.log(`  Created: ${nStake.stakeId}`);

header(8, 'test-newbie attempts $50 (should REJECT)');
showAtt(decideTrade({ agentId: 'test-newbie', tradeSizeUSD: 50 }));

header(9, 'test-newbie attempts $20 (should APPROVE)');
showAtt(decideTrade({ agentId: 'test-newbie', tradeSizeUSD: 20 }));

header(10, 'banned-bot (RepID 0) attempts trade (should REJECT on RepID)');
stakeAndBind(alice.userId, 'banned-bot', 100);
showAtt(decideTrade({ agentId: 'banned-bot', tradeSizeUSD: 1 }));

header(11, 'Show alice full position with all 3 stakes');
showPos(alice.userId);

header(12, 'Alice withdraws test-newbie stake');
withdrawStake(nStake.stakeId);
console.log(`  Withdrew: ${nStake.stakeId}`);

header(13, 'Show final position (test-newbie gone)');
showPos(alice.userId);

header(14, 'Trade ledger');
console.log(`  Total: ${state.tradeAttempts.length}`);
state.tradeAttempts.forEach(a => console.log(`  [${a.decision === 'approved' ? 'OK' : 'NO'}] ${a.agentId.padEnd(12)} | $${String(a.tradeSizeUSD).padEnd(5)} | ${a.decision}`));

console.log('\n' + '='.repeat(72) + '\nDEMO COMPLETE\n' + '='.repeat(72) + '\n');
