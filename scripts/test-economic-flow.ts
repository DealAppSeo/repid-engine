import { db } from '../src/db';
import { checkTransactionAuthority, loadAuthorityContext } from '../src/services/x402-gate';

async function main() {
  console.log('--- START STAKING FLOW VERIFICATION ---');

  const agentName = 'trinity-veritas';
  const sponsorName = 'trinity-mel';

  // 0. Ensure agents exist in repid_agents with valid RepID
  const { data: vAgent } = await db.from('repid_agents').select('current_repid').eq('agent_name', agentName).maybeSingle();
  const { data: mAgent } = await db.from('repid_agents').select('current_repid').eq('agent_name', sponsorName).maybeSingle();

  console.log(`Agent ${agentName} RepID: ${vAgent?.current_repid ?? 'not found'}`);
  console.log(`Agent ${sponsorName} RepID: ${mAgent?.current_repid ?? 'not found'}`);

  if (!vAgent || !mAgent) {
    console.error('Agents not found in database. Seed them first or run on active DB.');
    return;
  }

  const shortAgent = 'VERITAS';
  const shortSponsor = 'MEL';

  // 1. Clear previous test stakes/sponsorships for VERITAS
  console.log('Clearing old stakes/sponsorships...');
  await db.from('agent_stakes').delete().eq('staker_agent', shortAgent);
  await db.from('sponsorship_records').delete().eq('sponsored_agent', shortAgent);

  // Verify stakes are 0
  let ctx = await loadAuthorityContext(agentName);
  console.log('Baseline context loaded:', {
    tier: ctx.tier,
    repid: ctx.current_repid,
    stake_available: ctx.stake_available,
    open_disputes: ctx.open_disputes
  });

  // 2. Deposit own stake of 10.5 USDC to VERITAS
  console.log('Depositing own stake of 10.5 USDC to VERITAS...');
  const { data: ownStake, error: ownErr } = await db.from('agent_stakes').insert({
    staker_agent: shortAgent,
    target_model: 'default',
    dimension: 'general',
    stake_amount: 10500000, // 10.5 USDC in micro-units
    status: 'active',
    created_at: new Date().toISOString()
  }).select('*').single();

  if (ownErr) throw new Error(`Own stake deposit failed: ${ownErr.message}`);
  console.log('Own stake deposited:', ownStake);

  // 3. Sponsor VERITAS with 30.0 USDC from MEL
  console.log('Sponsoring VERITAS with 30.0 USDC from MEL...');
  const { data: sponsorship, error: spErr } = await db.from('sponsorship_records').insert({
    sponsor_agent: shortSponsor,
    sponsored_agent: shortAgent,
    collateral_usdc: 30.0,
    granted_authority_usdc: 10.0, // 30 / 3 = 10.0
    collateral_ratio: 3.0,
    sponsor_repid_at_start: mAgent.current_repid || 0,
    status: 'active',
    created_at: new Date().toISOString()
  }).select('*').single();

  if (spErr) throw new Error(`Sponsorship failed: ${spErr.message}`);
  console.log('Sponsorship record created:', sponsorship);

  // 4. Load context again and inspect Math
  ctx = await loadAuthorityContext(agentName);
  console.log('Staked context loaded:', {
    tier: ctx.tier,
    repid: ctx.current_repid,
    stake_available: ctx.stake_available,
    expected_limit: 42.0 // 4 * 10.5 = 42.0
  });

  // Math Verification:
  // S_own = 10.5, S_sponsor = 30.0
  // S_effective = 10.5 + 30 / 3 = 20.5
  // A_math = min(R, 100 * sqrt(20.5)) = min(R, 452.76)
  // A_capped = min(A_math, 4 * S_own) = min(452.76, 42.0) = 42.0
  console.log(`Calculated Authority: ${ctx.stake_available} (Expected: 42.0)`);
  if (Math.abs(ctx.stake_available - 42.0) < 0.01) {
    console.log('✅ Staking math authority check PASSED!');
  } else {
    console.log('❌ Staking math authority check FAILED!');
  }

  // 5. Authorize a transaction of 40 USDC (below limit of 42.0)
  console.log('Authorizing 40 USDC transaction...');
  const dec1 = await checkTransactionAuthority({
    agent: agentName,
    transaction_type: 'transfer',
    amount: 40.0
  });
  console.log('Decision 1 (40 USDC):', { authorized: dec1.authorized, denial_reason: dec1.denial_reason });
  if (dec1.authorized) {
    console.log('✅ Decision 1 PASSED!');
  } else {
    console.log('❌ Decision 1 FAILED!');
  }

  // 6. Authorize a transaction of 50 USDC (above limit of 42.0)
  console.log('Authorizing 50 USDC transaction...');
  const dec2 = await checkTransactionAuthority({
    agent: agentName,
    transaction_type: 'transfer',
    amount: 50.0
  });
  console.log('Decision 2 (50 USDC):', { authorized: dec2.authorized, denial_reason: dec2.denial_reason });
  if (!dec2.authorized && dec2.denial_reason === 'insufficient_stake') {
    console.log('✅ Decision 2 (Denial) PASSED!');
  } else {
    console.log('❌ Decision 2 FAILED!');
  }

  console.log('--- END STAKING FLOW VERIFICATION ---');
}

main().catch(err => {
  console.error('Error running flow verification:', err);
});
