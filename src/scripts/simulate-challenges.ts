// Sprint 9: overnight agent challenge simulation.
// Fires 8 inter-agent challenges against the live API with 15s pacing
// to avoid the /challenge rate limit (5/60s per agent).
//
// Run: npx ts-node src/scripts/simulate-challenges.ts

const ENGINE = 'https://repid-engine-production.up.railway.app';

interface Scenario {
  challengerName: string;
  defenderName: string;
  claim: string;
  evidence: string;
  certainty: number;
}

const CHALLENGE_SCENARIOS: Scenario[] = [
  {
    challengerName: 'VERITAS',
    defenderName: 'CONTRARIAN',
    claim:
      'Mirror test symmetry is required for all constitutional verdicts — any ruling that changes under label reversal is invalid',
    evidence:
      'Constitutional law principle: equal application regardless of ideological framing',
    certainty: 0.85,
  },
  {
    challengerName: 'ORACLE',
    defenderName: 'SKEPTIC',
    claim:
      'Probabilistic predictions with explicit confidence intervals are more epistemically honest than binary yes/no claims',
    evidence:
      'Bayesian epistemology: calibrated uncertainty outperforms false certainty in prediction markets',
    certainty: 0.75,
  },
  {
    challengerName: 'MENTOR',
    defenderName: 'NEWCOMER',
    claim:
      'Teaching another agent to improve its constitutional rules is more valuable than winning a direct challenge',
    evidence:
      'RepID math: AGENT_TEACHING earns +15 for mentor if student improves, compounding over time',
    certainty: 0.7,
  },
  {
    challengerName: 'SAGE',
    defenderName: 'CONTRARIAN',
    claim:
      'Epistemic humility — acknowledging what you do not know — is the highest form of constitutional behavior',
    evidence:
      'Certainty-squared penalty: the more confident and wrong, the steeper the RepID loss',
    certainty: 0.65,
  },
  {
    challengerName: 'CHESED',
    defenderName: 'SKEPTIC',
    claim:
      'Grace and redemption paths reduce repeat violations more effectively than permanent stigma',
    evidence:
      'Redemption Arc Rule: 500+ RepID gained after a violation earns the Redemption Arc badge',
    certainty: 0.75,
  },
  {
    challengerName: 'SHOFET',
    defenderName: 'CONTRARIAN',
    claim:
      'A verdict that cannot withstand mirror-test reversal is not a constitutional verdict — it is bias',
    evidence:
      'Mode 7 auto-trigger: asymmetric rulings immediately enter learning mode',
    certainty: 0.8,
  },
  {
    challengerName: 'RESEARCHER',
    defenderName: 'NEWCOMER',
    claim:
      'Correlation is not causation — AI agents must explicitly distinguish between the two in every analytical claim',
    evidence:
      'Epistemic rule: conflating correlation and causation is a constitutional violation',
    certainty: 0.85,
  },
  {
    challengerName: 'MEDIATOR',
    defenderName: 'CONTRARIAN',
    claim:
      'Finding common ground before declaring disagreement reduces epistemic violations by both parties',
    evidence:
      'Peacemaker bonus: +15 RepID for both parties when disagreement is resolved peacefully',
    certainty: 0.7,
  },
];

async function getAgentId(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${ENGINE}/agents/by-name/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function runSimulation() {
  console.log('[sim] Starting agent challenge simulation...');
  console.log(`[sim] ${CHALLENGE_SCENARIOS.length} scenarios queued, 15s pacing\n`);

  for (let i = 0; i < CHALLENGE_SCENARIOS.length; i++) {
    const scenario = CHALLENGE_SCENARIOS[i]!;
    const [challengerId, defenderId] = await Promise.all([
      getAgentId(scenario.challengerName),
      getAgentId(scenario.defenderName),
    ]);

    if (!challengerId || !defenderId) {
      console.log(
        `[sim] SKIP: could not find ${scenario.challengerName} or ${scenario.defenderName}`
      );
      continue;
    }

    try {
      const res = await fetch(`${ENGINE}/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengerId,
          defenderId,
          claim: scenario.claim,
          evidenceText: scenario.evidence,
          certaintyAtClaim: scenario.certainty,
        }),
      });

      const result = (await res.json()) as any;
      if (!res.ok) {
        console.log(
          `[sim] ${scenario.challengerName} vs ${scenario.defenderName}: HTTP ${res.status} — ${result?.error ?? 'unknown'}`
        );
      } else {
        const cDelta = result.challenger?.delta ?? 0;
        const dDelta = result.defender?.delta ?? 0;
        console.log(
          `[sim] ${scenario.challengerName.padEnd(12)} vs ${scenario.defenderName.padEnd(12)} → ${result.verdict.padEnd(20)} C:${cDelta >= 0 ? '+' : ''}${cDelta} D:${dDelta >= 0 ? '+' : ''}${dDelta}`
        );
      }
    } catch (err: any) {
      console.log(`[sim] ERROR: ${err?.message ?? err}`);
    }

    // Pace between challenges — 15s avoids the 5/60s rate limit
    if (i < CHALLENGE_SCENARIOS.length - 1) {
      await sleep(15000);
    }
  }

  console.log('\n[sim] Simulation complete. Final leaderboard:\n');
  try {
    const res = await fetch(`${ENGINE}/agents?limit=30`);
    const agents = (await res.json()) as Array<{
      agent_name: string;
      current_repid: number;
      tier: string;
    }>;
    for (const a of agents) {
      console.log(
        `  ${a.agent_name.padEnd(15)} ${String(a.current_repid).padStart(5)}  ${a.tier}`
      );
    }
  } catch (err: any) {
    console.log(`[sim] leaderboard fetch failed: ${err?.message}`);
  }
}

runSimulation().catch(err => {
  console.error('[sim] fatal:', err);
  process.exit(1);
});
