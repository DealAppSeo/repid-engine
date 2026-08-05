/**
 * bound-repid-sim.mjs — what does 67/33 parallel RepID actually DO to people?
 *
 * The proposal: when a bound entity acts, 67% of the RepID delta goes to the
 * actor and 33% to the entity it is bound to. Unbinding ends the effect.
 * The intent is skin-in-the-game: you cannot launder a bad agent by standing
 * at arm's length from it, and a good owner is rewarded for curating well.
 *
 * WHY THIS IS A SCRIPT AND NOT A PROMPT. This is deterministic arithmetic over
 * a seeded Monte Carlo. An LLM asked to "simulate" it has no execution
 * instrument and will return plausible-looking numbers — which is exactly the
 * failure documented in the swarm this week (an agent with no tool and one
 * affordance writes prose). Numbers come from running this. Judgement about
 * whether the DESIGN is right is a separate question, and a good one to put to
 * a different model — with this file and its output attached, so the reviewer
 * can reach the evidence.
 *
 * GROUNDED IN THE REAL RULER (src/engine/repid-update.ts):
 *   rewards  FIXED_DELTAS +5 (STAKE) .. +25 (CODE_CONTRIBUTION)
 *   penalty  -10 HAL veto, -15 HANDOFF_COSIGN_FALSE_PASS_SLASH
 *   clamp    [10, 10000]
 *   tiers    PROBATIONARY <500, EARNING <1000, ESTABLISHED <5000,
 *            AUTONOMOUS <8000, VETERAN >=8000
 *
 * Usage:  node scripts/sim/bound-repid-sim.mjs [--ticks 2000] [--trials 200]
 */

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const TICKS = arg('ticks', 2000);
const TRIALS = arg('trials', 200);

/** Seeded PRNG (mulberry32) — reproducible, so a number here can be re-derived. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLAMP = (v) => Math.max(10, Math.min(10000, v));
const TIERS = [
  [8000, 'VETERAN'],
  [5000, 'AUTONOMOUS'],
  [1000, 'ESTABLISHED'],
  [500, 'EARNING'],
  [0, 'PROBATIONARY'],
];
const tierOf = (v) => TIERS.find(([min]) => v >= min)[1];

/** Real reward spread: mostly small stakes, occasionally a big contribution. */
const REWARDS = [5, 5, 5, 10, 10, 12, 15, 15, 20, 25];
const PENALTIES = [-10, -10, -10, -15];

/**
 * THE FOUR PROPAGATION MODELS.
 *
 * `split` and `mirror` are the two readings of "67/33" — and they are NOT the
 * same proposal. Under `split` the actor takes a 33% HAIRCUT for being bound;
 * under `mirror` the actor is untouched and the bound party gets a bonus on
 * top. Which one is meant decides whether binding is a cost or a free ride.
 *
 * `asymmetric` is the variant this simulation exists to argue for: see the
 * dilution result in the output.
 */
const MODELS = {
  unbound: { gainActor: 1.0, gainBound: 0.0, lossActor: 1.0, lossBound: 0.0 },
  split: { gainActor: 0.67, gainBound: 0.33, lossActor: 0.67, lossBound: 0.33 },
  mirror: { gainActor: 1.0, gainBound: 0.33, lossActor: 1.0, lossBound: 0.33 },
  asymmetric: { gainActor: 0.67, gainBound: 0.33, lossActor: 1.0, lossBound: 0.33 },
};

/**
 * One run. `qh`/`qa` are P(action is good) for human and agent.
 * `agentShare` = fraction of actions taken by the agent (agents are busier).
 * `escapeAt` — if set, the human unbinds once their own RepID falls this far
 *   below where they started. Models the free-option problem.
 */
function simulate({ qh, qa, model, seed, agentShare = 0.8, escapeAt = null, start = 1000 }) {
  const r = rng(seed);
  const m = MODELS[model];
  let human = start;
  let agent = start;
  let bound = model !== 'unbound';
  let unboundAt = null;

  for (let t = 0; t < TICKS; t++) {
    const actorIsAgent = r() < agentShare;
    const q = actorIsAgent ? qa : qh;
    const good = r() < q;
    const base = good
      ? REWARDS[Math.floor(r() * REWARDS.length)]
      : PENALTIES[Math.floor(r() * PENALTIES.length)];

    const aShare = bound ? (good ? m.gainActor : m.lossActor) : 1.0;
    const bShare = bound ? (good ? m.gainBound : m.lossBound) : 0.0;

    if (actorIsAgent) {
      agent = CLAMP(agent + base * aShare);
      human = CLAMP(human + base * bShare);
    } else {
      human = CLAMP(human + base * aShare);
      agent = CLAMP(agent + base * bShare);
    }

    if (bound && escapeAt !== null && human <= start - escapeAt) {
      bound = false;
      unboundAt = t;
    }
  }
  return { human: Math.round(human), agent: Math.round(agent), unboundAt };
}

/** Average over trials so a single seed cannot tell the story. */
function avg({ qh, qa, model, agentShare = 0.8, escapeAt = null }) {
  let h = 0;
  let a = 0;
  let escapes = 0;
  for (let i = 0; i < TRIALS; i++) {
    const res = simulate({ qh, qa, model, seed: 1337 + i * 7919, agentShare, escapeAt });
    h += res.human;
    a += res.agent;
    if (res.unboundAt !== null) escapes++;
  }
  return { human: Math.round(h / TRIALS), agent: Math.round(a / TRIALS), escapeRate: escapes / TRIALS };
}

const SCENARIOS = [
  { name: 'good human + BAD agent', qh: 0.95, qa: 0.30 },
  { name: 'BAD human + good agent', qh: 0.30, qa: 0.95 },
  { name: 'good human + good agent', qh: 0.95, qa: 0.95 },
  { name: 'BAD human + BAD agent', qh: 0.30, qa: 0.30 },
];

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\nBOUND REPID SIMULATION — ${TICKS} actions, ${TRIALS} trials, start 1000 each`);
console.log(`agent takes 80% of actions (agents are busier than their owners)`);
console.log(`ruler: rewards +5..+25, penalties -10/-15, clamp [10,10000]\n`);

for (const s of SCENARIOS) {
  console.log(`\n=== ${s.name}  (P(good): human ${s.qh}, agent ${s.qa}) ===`);
  console.log(
    `${pad('model', 12)} ${padL('HUMAN', 8)} ${pad('tier', 14)} ${padL('AGENT', 8)} ${pad('tier', 14)}`,
  );
  for (const model of Object.keys(MODELS)) {
    const { human, agent } = avg({ ...s, model });
    console.log(
      `${pad(model, 12)} ${padL(human, 8)} ${pad(tierOf(human), 14)} ${padL(agent, 8)} ${pad(tierOf(agent), 14)}`,
    );
  }
}

/**
 * THE DILUTION TEST — the reason `asymmetric` exists.
 *
 * A bad agent acting alone eats 100% of its own penalties. Under a symmetric
 * `split`, that same bad agent bound to a human eats only 67% of them. If that
 * is true, binding is a PUNISHMENT-LAUNDERING MECHANISM: the worst actors have
 * the strongest incentive to go find someone to bind to.
 */
console.log(`\n\n=== DILUTION TEST — does binding soften a bad agent's own penalty? ===`);
console.log(`A deliberately bad agent (P(good)=0.20), agent takes 100% of actions.\n`);
console.log(`${pad('model', 12)} ${padL('AGENT ends', 11)}  ${pad('tier', 14)} verdict`);
for (const model of Object.keys(MODELS)) {
  const { agent } = avg({ qh: 0.95, qa: 0.2, model, agentShare: 1.0 });
  const base = avg({ qh: 0.95, qa: 0.2, model: 'unbound', agentShare: 1.0 }).agent;
  const delta = agent - base;
  const verdict =
    model === 'unbound'
      ? '(baseline)'
      : delta > 25
        ? `DILUTED — ${delta} higher than acting alone. Binding SOFTENS the penalty.`
        : 'penalty intact';
  console.log(`${pad(model, 12)} ${padL(agent, 11)}  ${pad(tierOf(agent), 14)} ${verdict}`);
}

/**
 * THE ESCAPE-HATCH TEST — is the binding a free option?
 *
 * If bad news propagates but the owner can unbind the moment it starts to
 * hurt, they keep the upside and dump the downside.
 */
console.log(`\n\n=== ESCAPE-HATCH TEST — can an owner dump the downside? ===`);
console.log(`good human + BAD agent, human unbinds after losing 100 RepID.\n`);
console.log(`${pad('model', 12)} ${padL('stays bound', 12)} ${padL('can unbind', 12)}  ${pad('escaped?', 10)}`);
for (const model of ['split', 'mirror', 'asymmetric']) {
  const held = avg({ qh: 0.95, qa: 0.3, model }).human;
  const esc = avg({ qh: 0.95, qa: 0.3, model, escapeAt: 100 });
  console.log(
    `${pad(model, 12)} ${padL(held, 12)} ${padL(esc.human, 12)}  ${pad(`${Math.round(esc.escapeRate * 100)}% of runs`, 10)}`,
  );
}

/**
 * SYBIL TEST — one owner, many agents. Each binding pays the owner 33% of that
 * agent's gains, so an owner who binds N decent agents collects N x 33%.
 */
console.log(`\n\n=== SYBIL TEST — owner binds N good agents and does nothing themselves ===`);
console.log(`Owner takes 0% of actions. Inbound 33% from each agent, additive.\n`);
console.log(`${pad('N agents', 10)} ${padL('owner ends', 11)}  ${pad('tier', 14)}`);
for (const n of [1, 3, 10, 25]) {
  // Each bound agent independently contributes its 33% stream to the owner.
  const perAgent = avg({ qh: 0.95, qa: 0.9, model: 'mirror', agentShare: 1.0 });
  const gainPerAgent = perAgent.human - 1000;
  const owner = CLAMP(1000 + gainPerAgent * n);
  console.log(`${pad(n, 10)} ${padL(Math.round(owner), 11)}  ${pad(tierOf(owner), 14)}`);
}

console.log('');
