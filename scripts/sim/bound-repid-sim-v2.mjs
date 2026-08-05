/**
 * bound-repid-sim-v2.mjs — the four decisions v1 left open.
 *
 * v1 established that a SYMMETRIC 67/33 split launders punishment (a bad agent
 * keeps only 67% of its own penalties, and gains a tier by binding). It left
 * four questions that have to be answered before any ratio is chosen:
 *
 *   Q1 RATIO      is 67/33 the right number, or does the answer barely depend
 *                 on it? Sweep 100/0 .. 50/50.
 *   Q2 SYBIL      additive inbound vs 33%/N normalisation vs a hard cap.
 *   Q3 TAIL RISK  the mean says a good owner "holds their tier". What does the
 *                 5th percentile say? Means hide exactly the case that makes
 *                 someone rage-quit.
 *   Q4 ADOPTION   does asymmetric loss-sharing make binding so expensive that
 *                 a GOOD agent refuses? A rule nobody opts into is not a rule.
 *
 * Same ruler as v1 (src/engine/repid-update.ts): rewards +5..+25, penalties
 * -10/-15, clamp [10,10000], live tier bounds. Inert — imports nothing.
 *
 * Usage: node scripts/sim/bound-repid-sim-v2.mjs [--ticks 200] [--trials 400]
 */

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : d;
};
const TICKS = arg('ticks', 200);
const TRIALS = arg('trials', 400);

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
const tierOf = (v) => TIERS.find(([m]) => v >= m)[1];
const REWARDS = [5, 5, 5, 10, 10, 12, 15, 15, 20, 25];
const PENALTIES = [-10, -10, -10, -15];

/**
 * `lossActor: 1.0` is the v1 recommendation — the actor never sheds any of its
 * own penalty. `boundShare` is what the partner additionally absorbs.
 */
function run1({ qh, qa, actorShare, boundShare, lossActor, seed, agentShare = 0.8, nBindings = 1 }) {
  const r = rng(seed);
  let human = 1000;
  let agent = 1000;
  for (let t = 0; t < TICKS; t++) {
    const isAgent = r() < agentShare;
    const good = r() < (isAgent ? qa : qh);
    const base = good
      ? REWARDS[Math.floor(r() * REWARDS.length)]
      : PENALTIES[Math.floor(r() * PENALTIES.length)];
    const aS = good ? actorShare : lossActor;
    // Normalisation divisor: 1 = additive (v1 behaviour), nBindings = 33%/N.
    const bS = boundShare / nBindings;
    if (isAgent) {
      agent = CLAMP(agent + base * aS);
      human = CLAMP(human + base * bS);
    } else {
      human = CLAMP(human + base * aS);
      agent = CLAMP(agent + base * bS);
    }
  }
  return { human, agent };
}

function dist(cfg) {
  const hs = [];
  const as = [];
  for (let i = 0; i < TRIALS; i++) {
    const { human, agent } = run1({ ...cfg, seed: 1337 + i * 7919 });
    hs.push(human);
    as.push(agent);
  }
  hs.sort((x, y) => x - y);
  as.sort((x, y) => x - y);
  const q = (arr, p) => Math.round(arr[Math.floor(p * (arr.length - 1))]);
  return {
    hMean: Math.round(hs.reduce((a, b) => a + b, 0) / hs.length),
    hP5: q(hs, 0.05),
    hP50: q(hs, 0.5),
    aMean: Math.round(as.reduce((a, b) => a + b, 0) / as.length),
    aP5: q(as, 0.05),
    // How often the owner is knocked out of ESTABLISHED (<1000) entirely.
    hDemoted: hs.filter((v) => v < 1000).length / hs.length,
  };
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\nBOUND REPID SIM v2 — ${TICKS} actions, ${TRIALS} trials, start 1000, agent acts 80%`);
console.log(`loss branch: actor always eats 100% (the v1 recommendation)\n`);

/* ---------------- Q1 RATIO SWEEP ---------------- */
console.log(`=== Q1 — RATIO SWEEP: good human + BAD agent (0.95 / 0.30) ===`);
console.log(`Does the split ratio actually change the outcome?\n`);
console.log(
  `${pad('gain split', 12)} ${padL('HUMAN mean', 11)} ${padL('p5', 7)} ${pad('  tier@mean', 15)} ${padL('AGENT mean', 11)} ${pad('  tier', 14)}`,
);
for (const [actorShare, boundShare] of [
  [1.0, 0.0],
  [0.9, 0.1],
  [0.8, 0.2],
  [0.67, 0.33],
  [0.5, 0.5],
]) {
  const d = dist({ qh: 0.95, qa: 0.3, actorShare, boundShare, lossActor: 1.0 });
  const label = `${Math.round(actorShare * 100)}/${Math.round(boundShare * 100)}`;
  console.log(
    `${pad(label, 12)} ${padL(d.hMean, 11)} ${padL(d.hP5, 7)} ${pad('  ' + tierOf(d.hMean), 15)} ${padL(d.aMean, 11)} ${pad('  ' + tierOf(d.aMean), 14)}`,
  );
}

/* ---------------- Q3 TAIL RISK ---------------- */
console.log(`\n\n=== Q3 — TAIL RISK at 67/33: what does the unlucky owner see? ===`);
console.log(`"holds their tier" is a claim about the MEAN. Checking the tail.\n`);
console.log(`${pad('scenario', 26)} ${padL('mean', 7)} ${padL('p50', 7)} ${padL('p5', 7)}  ${pad('P(demoted <1000)', 18)}`);
for (const [name, qh, qa] of [
  ['good human + BAD agent', 0.95, 0.3],
  ['good human + mediocre', 0.95, 0.6],
  ['good human + good agent', 0.95, 0.95],
]) {
  const d = dist({ qh, qa, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0 });
  console.log(
    `${pad(name, 26)} ${padL(d.hMean, 7)} ${padL(d.hP50, 7)} ${padL(d.hP5, 7)}  ${pad((d.hDemoted * 100).toFixed(1) + '%', 18)}`,
  );
}

/* ---------------- Q2 SYBIL ---------------- */
console.log(`\n\n=== Q2 — SYBIL: owner takes ZERO actions, binds N good agents ===`);
console.log(`additive (v1) vs 33%/N normalisation. Owner earns nothing themselves.\n`);
console.log(`${pad('N', 5)} ${padL('additive', 10)} ${pad('  tier', 15)} ${padL('33%/N', 10)} ${pad('  tier', 15)}`);
for (const n of [1, 3, 10, 25]) {
  // One agent's contribution stream to an idle owner.
  const per = dist({ qh: 0.95, qa: 0.9, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0, agentShare: 1.0 });
  const gain = per.hMean - 1000;
  const additive = CLAMP(1000 + gain * n);
  const normalised = CLAMP(1000 + (gain * n) / n); // 33%/N -> total inbound is capped at one agent's worth
  console.log(
    `${pad(n, 5)} ${padL(Math.round(additive), 10)} ${pad('  ' + tierOf(additive), 15)} ${padL(Math.round(normalised), 10)} ${pad('  ' + tierOf(normalised), 15)}`,
  );
}

/* ---------------- Q4 ADOPTION ---------------- */
console.log(`\n\n=== Q4 — ADOPTION: what does binding COST a good agent? ===`);
console.log(`A good agent (0.95) bound to owners of varying quality, vs staying solo.`);
console.log(`If binding is strictly worse for good agents, only bad ones will bind.\n`);
console.log(`${pad('owner quality', 16)} ${padL('agent solo', 11)} ${padL('agent bound', 12)} ${padL('cost', 8)}  verdict`);
const solo = dist({ qh: 0.95, qa: 0.95, actorShare: 1.0, boundShare: 0.0, lossActor: 1.0 }).aMean;
for (const [label, qh] of [
  ['good (0.95)', 0.95],
  ['average (0.60)', 0.6],
  ['bad (0.30)', 0.3],
]) {
  const bound = dist({ qh, qa: 0.95, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0 }).aMean;
  const cost = bound - solo;
  const verdict =
    cost >= 0 ? 'binding PAYS the agent' : cost > -300 ? 'mild cost — tolerable' : 'STRONG disincentive to bind';
  console.log(
    `${pad(label, 16)} ${padL(solo, 11)} ${padL(bound, 12)} ${padL(cost > 0 ? '+' + cost : cost, 8)}  ${verdict}`,
  );
}

/* ---------------- Q5 MIRROR ---------------- */
/**
 * Q4 kills the v1 recommendation. Under `split+asymmetric` a good agent loses
 * ~464 RepID by binding to a GOOD owner — gains cut to 67%, losses left at
 * 100%. So no agent with a reputation worth keeping would ever bind, and the
 * rule selects for agents that have nothing to lose. That is adverse
 * selection: precisely backwards.
 *
 * MIRROR is the third option, and it matches the stated intent better:
 * each party keeps 100% of its OWN deltas, and additionally absorbs 33% of its
 * partner's — in both directions. "They can help and/or hinder their RepID as
 * they are bound" is exactly a mirror, not a split. Nothing is taken from the
 * actor, so there is no adoption cost and no punishment dilution.
 */
console.log(`\n\n=== Q5 — MIRROR (100/+33) vs SPLIT (67/33), both with actor eating 100% of loss ===`);
console.log(`mirror: each keeps ALL of its own, and absorbs 33% of its partner's, both ways.\n`);
console.log(`${pad('test', 34)} ${padL('split 67/33', 12)} ${padL('mirror', 10)}  ${pad('what it means', 30)}`);

const soloA = dist({ qh: 0.95, qa: 0.95, actorShare: 1.0, boundShare: 0.0, lossActor: 1.0 }).aMean;
const splitAdopt = dist({ qh: 0.95, qa: 0.95, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0 }).aMean;
const mirrorAdopt = dist({ qh: 0.95, qa: 0.95, actorShare: 1.0, boundShare: 0.33, lossActor: 1.0 }).aMean;
console.log(
  `${pad('good agent cost to bind', 34)} ${padL(splitAdopt - soloA, 12)} ${padL(mirrorAdopt - soloA, 10)}  ${pad('mirror: no cost -> agents opt in', 30)}`,
);

// Dilution: does a bad agent shed its own penalty?
const dilBase = dist({ qh: 0.95, qa: 0.2, actorShare: 1.0, boundShare: 0.0, lossActor: 1.0, agentShare: 1.0 }).aMean;
const dilSplit = dist({ qh: 0.95, qa: 0.2, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0, agentShare: 1.0 }).aMean;
const dilMirror = dist({ qh: 0.95, qa: 0.2, actorShare: 1.0, boundShare: 0.33, lossActor: 1.0, agentShare: 1.0 }).aMean;
console.log(
  `${pad('bad agent vs acting alone', 34)} ${padL(dilSplit - dilBase, 12)} ${padL(dilMirror - dilBase, 10)}  ${pad('0 = penalty fully intact', 30)}`,
);

// Owner exposure: does the owner still get hurt by a bad agent?
const ownSplit = dist({ qh: 0.95, qa: 0.3, actorShare: 0.67, boundShare: 0.33, lossActor: 1.0 });
const ownMirror = dist({ qh: 0.95, qa: 0.3, actorShare: 1.0, boundShare: 0.33, lossActor: 1.0 });
console.log(
  `${pad('good owner w/ bad agent (mean)', 34)} ${padL(ownSplit.hMean, 12)} ${padL(ownMirror.hMean, 10)}  ${pad('exposure must stay REAL', 30)}`,
);
console.log(
  `${pad('  ...their p5 (unlucky owner)', 34)} ${padL(ownSplit.hP5, 12)} ${padL(ownMirror.hP5, 10)}  ${pad('the rage-quit case', 30)}`,
);
console.log(
  `${pad('  ...P(demoted below 1000)', 34)} ${padL((ownSplit.hDemoted * 100).toFixed(1) + '%', 12)} ${padL((ownMirror.hDemoted * 100).toFixed(1) + '%', 10)}  ${pad('lower is kinder, 0% = no stake', 30)}`,
);

console.log('');
