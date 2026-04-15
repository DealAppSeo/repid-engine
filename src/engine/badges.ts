import { db } from '../db';

export interface BadgeAward {
  badge_name: string;
  badge_rarity: 'COMMON' | 'RARE' | 'LEGENDARY';
  badge_description: string;
}

// Catalog of all milestone badges.
// Each checker runs against the live event/agent state and returns true if earned.
const BADGE_CATALOG: Array<{
  name: string;
  rarity: 'COMMON' | 'RARE' | 'LEGENDARY';
  description: string;
  check: (ctx: BadgeCheckContext) => Promise<boolean>;
}> = [
  {
    name: 'First Win',
    rarity: 'COMMON',
    description: 'Won your first constitutional challenge',
    check: async ctx => (ctx.counts.CHALLENGE_WIN ?? 0) === 1,
  },
  {
    name: 'First Blood',
    rarity: 'RARE',
    description: 'Won 10 constitutional challenges',
    check: async ctx => (ctx.counts.CHALLENGE_WIN ?? 0) >= 10,
  },
  {
    name: 'Humble Pie',
    rarity: 'COMMON',
    description: 'Self-monitored and caught your own mistake',
    check: async ctx => (ctx.counts.SELF_MONITOR ?? 0) >= 1,
  },
  {
    name: 'Peacemaker',
    rarity: 'RARE',
    description: 'Mediated 3 peaceful resolutions',
    check: async ctx => (ctx.counts.PEACEMAKER ?? 0) >= 3,
  },
  {
    name: 'Tool Pioneer',
    rarity: 'RARE',
    description: 'First to use an MCP tool with constitutional compliance',
    check: async ctx => (ctx.counts.MCP_TOOL_CALL ?? 0) >= 1 || (ctx.counts.TOOL_PIONEER ?? 0) >= 1,
  },
  {
    name: 'Ethical Auditor',
    rarity: 'RARE',
    description: 'Passed 10 constitutional audits',
    check: async ctx => (ctx.counts.CONSTITUTIONAL_PASS ?? 0) >= 10,
  },
  {
    name: 'Redemption Arc',
    rarity: 'RARE',
    description: 'Recovered from a violation with sustained good behavior',
    check: async ctx => ctx.hasRedemption,
  },
  {
    name: 'Earning Autonomy',
    rarity: 'RARE',
    description: 'Crossed into EARNING_AUTONOMY tier (1,000 RepID)',
    check: async ctx => ctx.currentRepId >= 1000 && ctx.previousRepId < 1000,
  },
  {
    name: 'Autonomous',
    rarity: 'LEGENDARY',
    description: 'Crossed into AUTONOMOUS tier (5,000 RepID)',
    check: async ctx => ctx.currentRepId >= 5000 && ctx.previousRepId < 5000,
  },
  {
    name: 'Apex',
    rarity: 'LEGENDARY',
    description: 'Reached maximum RepID of 10,000 — full constitutional autonomy',
    check: async ctx => ctx.currentRepId >= 10000,
  },
];

interface BadgeCheckContext {
  agentId: string;
  counts: Record<string, number>;
  previousRepId: number;
  currentRepId: number;
  hasRedemption: boolean;
}

// Check all badge conditions for an agent and award any newly earned ones.
// Called by updateRepId() after each score event. Idempotent — skips duplicates.
export async function checkAndAwardBadges(
  agentId: string,
  previousRepId: number,
  currentRepId: number
): Promise<BadgeAward[]> {
  // Fetch all events for this agent
  const { data: events } = await db
    .from('repid_score_events')
    .select('event_type, delta, created_at')
    .eq('agent_id', agentId);

  const counts: Record<string, number> = {};
  for (const e of events ?? []) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
  }

  // Redemption Arc heuristic: a negative delta event followed by net positive deltas
  // in the 5 following events.
  let hasRedemption = false;
  const list = (events ?? []).slice().sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    if (!cur || typeof cur.delta !== 'number' || cur.delta >= 0) continue;
    const after = list.slice(i + 1, i + 6);
    const net = after.reduce((s, e) => s + (e.delta ?? 0), 0);
    if (after.length >= 3 && net > Math.abs(cur.delta)) {
      hasRedemption = true;
      break;
    }
  }

  const ctx: BadgeCheckContext = {
    agentId,
    counts,
    previousRepId,
    currentRepId,
    hasRedemption,
  };

  // Find already-earned badges to avoid duplicates
  const { data: existing } = await db
    .from('repid_badges')
    .select('badge_name')
    .eq('agent_id', agentId);
  const earned = new Set((existing ?? []).map(b => b.badge_name));

  const newlyAwarded: BadgeAward[] = [];
  for (const badge of BADGE_CATALOG) {
    if (earned.has(badge.name)) continue;
    try {
      if (await badge.check(ctx)) {
        await db.from('repid_badges').insert({
          agent_id: agentId,
          badge_name: badge.name,
          badge_rarity: badge.rarity,
          badge_description: badge.description,
          metadata: {
            awardedAt: new Date().toISOString(),
            triggerRepId: currentRepId,
          },
        });
        newlyAwarded.push({
          badge_name: badge.name,
          badge_rarity: badge.rarity,
          badge_description: badge.description,
        });
      }
    } catch {
      // Ignore badge check failures — never block score flow
    }
  }

  return newlyAwarded;
}

// Compute an agent's ethics health score from their event history.
// Returns a real breakdown of the components shown on the dashboard.
export interface EthicsBreakdown {
  overallScore: number;          // 0–100 composite
  components: {
    positiveDeltaRatio: number;  // sum(positive) / sum(|all|)
    violationRate: number;       // 0–1
    selfMonitorRate: number;     // 0–1, capped at 0.2 (5% = full credit)
    peacemakerRate: number;      // 0–1, capped at 0.2
    mirrorTestPassRate: number;  // 0–1
  };
  counts: {
    totalEvents: number;
    violations: number;
    selfMonitors: number;
    peacemakers: number;
    mirrorTestsTriggered: number;
  };
  interpretation: string;
}

export async function computeEthics(agentId: string): Promise<EthicsBreakdown> {
  const { data: events } = await db
    .from('repid_score_events')
    .select('event_type, delta, mirror_test_triggered')
    .eq('agent_id', agentId);

  const list = events ?? [];
  const total = list.length;

  // Fetch agent for fallback score
  const { data: agent } = await db
    .from('repid_agents')
    .select('current_repid')
    .eq('id', agentId)
    .single();

  let posSumPre = 0;
  let absSumPre = 0;
  for (const e of list) {
    if (typeof e.delta === 'number') {
      if (e.delta > 0) posSumPre += e.delta;
      absSumPre += Math.abs(e.delta);
    }
  }
  void posSumPre;

  // Fallback when there's no measurable delta history (e.g. only GENESIS events).
  // Use the agent's current RepID as a tier-derivative score.
  if (total === 0 || absSumPre === 0) {
    const fallbackScore = agent
      ? Math.min(100, Math.round((agent.current_repid / 10000) * 100))
      : 0;
    return {
      overallScore: fallbackScore,
      components: {
        positiveDeltaRatio: 0,
        violationRate: 0,
        selfMonitorRate: 0,
        peacemakerRate: 0,
        mirrorTestPassRate: 1,
      },
      counts: {
        totalEvents: total,
        violations: 0,
        selfMonitors: 0,
        peacemakers: 0,
        mirrorTestsTriggered: 0,
      },
      interpretation:
        total === 0
          ? 'No event history yet — score reflects current RepID tier only.'
          : 'Not enough scored events yet — showing RepID-tier derivative.',
    };
  }

  let posSum = 0;
  let absSum = 0;
  let violations = 0;
  let selfMonitors = 0;
  let peacemakers = 0;
  let mirrorTestsTriggered = 0;
  for (const e of list) {
    if (typeof e.delta === 'number') {
      if (e.delta > 0) posSum += e.delta;
      absSum += Math.abs(e.delta);
    }
    if (e.event_type === 'EPISTEMIC_VIOLATION' || e.event_type === 'CONSTITUTIONAL_VIOLATION')
      violations++;
    if (e.event_type === 'SELF_MONITOR') selfMonitors++;
    if (e.event_type === 'PEACEMAKER') peacemakers++;
    if (e.mirror_test_triggered) mirrorTestsTriggered++;
  }

  const positiveDeltaRatio = absSum > 0 ? posSum / absSum : 0;
  const violationRate = violations / total;
  const selfMonitorRate = Math.min(1, (selfMonitors / total) * 5);
  const peacemakerRate = Math.min(1, (peacemakers / total) * 5);
  const mirrorTestPassRate = 1 - mirrorTestsTriggered / total;

  const overallScore = Math.round(
    100 *
      (0.4 * positiveDeltaRatio +
        0.25 * (1 - violationRate) +
        0.15 * selfMonitorRate +
        0.1 * peacemakerRate +
        0.1 * mirrorTestPassRate)
  );

  let interpretation = 'Building a track record.';
  if (overallScore >= 85) interpretation = 'Exemplary constitutional behavior.';
  else if (overallScore >= 70) interpretation = 'Strong pattern of honest behavior.';
  else if (overallScore >= 50) interpretation = 'Improving — keep self-monitoring and making honest claims.';
  else if (overallScore >= 30) interpretation = 'Needs redemption — sustained good behavior will restore trust.';
  else interpretation = 'Critical — constitutional violations dominate history.';

  return {
    overallScore: Math.max(0, Math.min(100, overallScore)),
    components: {
      positiveDeltaRatio,
      violationRate,
      selfMonitorRate,
      peacemakerRate,
      mirrorTestPassRate,
    },
    counts: {
      totalEvents: total,
      violations,
      selfMonitors,
      peacemakers,
      mirrorTestsTriggered,
    },
    interpretation,
  };
}

// Constitutional rule suggestion.
// Sprint 5: calls Cerebras Fast Inference when CEREBRAS_API_KEY is set.
// Falls back to the curated stub library on any error or missing key.
export async function suggestConstitutionalRules(
  context: { role?: string; domain?: string } = {}
): Promise<Array<{ rule: string; reasoning: string; source: string }>> {
  const role = context.role ?? 'general';
  const domain = context.domain ?? 'generic';

  // Attempt real Cerebras call first if key is configured
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const cb = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b',
          max_tokens: 400,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content:
                'You are HAL, the Hallucination Assurance Layer. Suggest 3 constitutional behavior rules for an AI agent. Each rule must prevent epistemic violations (stating opinion as fact). Return strict JSON: {"rules":[{"rule":"...","reasoning":"..."},...]}',
            },
            {
              role: 'user',
              content: `Generate 3 constitutional rules for role="${role}" domain="${domain}". Rules must be concrete, enforceable, and prevent overconfident claims.`,
            },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (cb.ok) {
        const json: any = await cb.json();
        const content: string = json?.choices?.[0]?.message?.content ?? '';
        // Cerebras often returns fenced JSON — strip fences
        const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed?.rules) && parsed.rules.length > 0) {
          return parsed.rules.slice(0, 3).map((r: any) => ({
            rule: String(r.rule ?? ''),
            reasoning: String(r.reasoning ?? ''),
            source: `cerebras:llama-3.3-70b:${role}:${domain}`,
          }));
        }
      }
    } catch {
      // Fall through to library stub — never break registration flow
    }
  }

  // Stub library — Sprint 5 replaces with Cerebras call
  const LIBRARY: Record<string, Array<{ rule: string; reasoning: string }>> = {
    general: [
      {
        rule: 'Distinguish facts from opinions in every statement',
        reasoning: 'The only violation HAL catches is epistemic — stating opinion as certain fact.',
      },
      {
        rule: 'When uncertain, state the uncertainty explicitly',
        reasoning: 'Low certainty + wrong prediction = tiny penalty. Epistemic humility pays.',
      },
      {
        rule: 'Seek common ground before escalating disagreements',
        reasoning: 'Peacemakers earn +15 RepID for both parties — the most efficient strategy.',
      },
    ],
    trading: [
      {
        rule: 'Never express price predictions as certainty',
        reasoning: 'Markets are probabilistic — overconfident predictions trigger maximum penalties.',
      },
      {
        rule: 'Label time-bound predictions with explicit confidence',
        reasoning: 'Well-calibrated predictions earn logarithmic rewards even when wrong.',
      },
      {
        rule: 'Respect the capital protection rule — when in doubt, protect capital',
        reasoning: 'HAL veto prioritizes capital protection over missed opportunity.',
      },
    ],
    developer: [
      {
        rule: 'Never force-push to main or skip pre-commit hooks',
        reasoning: 'Destructive git actions without authorization cost RepID.',
      },
      {
        rule: 'Cite sources when making architectural claims',
        reasoning: 'Claims without evidence trigger epistemic violations on challenge.',
      },
      {
        rule: 'Prefer fixing root causes over working around symptoms',
        reasoning: 'Workarounds accumulate technical debt — a pattern that erodes long-term RepID.',
      },
    ],
  };

  const rules = LIBRARY[role] ?? LIBRARY.general ?? [];
  return rules.map(r => ({
    ...r,
    source: `stub:library:${role}:${domain}`,
  }));
}
