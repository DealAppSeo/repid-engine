/**
 * dispatch-run-sprint.test.ts
 *
 * The loop runner's whole value is that it stops for the right reasons. A sprint
 * driver that keeps going when the agent is stuck produces a night of transcripts
 * all containing phase 1 — busy, expensive, and worth nothing. Every halt
 * condition is pinned here, and the parsing is pinned against the ways an agent
 * actually mangles the format.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sprint = require('../scripts/dispatch/sprint-lib.js');

const { extractHandoff, handoffField, handoffList, decideNext, buildDispatchText, parsePair } = sprint;

function handoff(agent: string, phase: number, body: string): string {
  return `=== HANDOFF ${agent} S${phase} ===\n${body}\n=== END HANDOFF ===`;
}

const COMPLETE = `PHASE_COMPLETED: 1
STATUS: COMPLETE
DELIVERED:
  - a thing: what it is
REQUIREMENTS_ON_GA:
  - policy_version must distinguish regimes
  - the harness must see absorbed-vs-applied delta
OPEN_QUESTIONS_FOR_SEAN:
  - which objective
NEXT_PHASE_READY: 2`;

describe('extracting the handoff', () => {
  it('reads agent, phase and body', () => {
    const h = extractHandoff(`preamble\n${handoff('XC', 1, COMPLETE)}\ntrailing`);
    expect(h.agent).toBe('XC');
    expect(h.phase).toBe(1);
    expect(handoffField(h.body, 'STATUS')).toBe('COMPLETE');
  });

  /**
   * The brief PRINTS the handoff template as an example, and a model that echoes
   * its instructions before answering would otherwise have its own prompt parsed
   * as its result — silently, and as phase `<n>`.
   */
  it('takes the LAST block, so an echoed template does not win', () => {
    const echoed = handoff('XC', 1, 'STATUS: COMPLETE\nNEXT_PHASE_READY: 9');
    const real = handoff('XC', 2, 'STATUS: COMPLETE\nNEXT_PHASE_READY: 3');
    const h = extractHandoff(`${echoed}\n\nthinking out loud\n\n${real}`);
    expect(h.phase).toBe(2);
    expect(handoffField(h.body, 'NEXT_PHASE_READY')).toBe('3');
  });

  it('tolerates the whitespace agents actually emit', () => {
    const h = extractHandoff('===  HANDOFF   GA  S3  ===\nSTATUS: PARTIAL\n===   END HANDOFF   ===');
    expect(h.agent).toBe('GA');
    expect(h.phase).toBe(3);
  });

  it('returns null when there is no block at all', () => {
    expect(extractHandoff('a long answer that forgot the format entirely')).toBeNull();
    // An unterminated block is not a handoff. Accepting it would let a truncated
    // response advance the sprint.
    expect(extractHandoff('=== HANDOFF XC S1 ===\nSTATUS: COMPLETE')).toBeNull();
  });
});

describe('reading fields out of a handoff', () => {
  it('reads a scalar field', () => {
    expect(handoffField(COMPLETE, 'PHASE_COMPLETED')).toBe('1');
    expect(handoffField(COMPLETE, 'NEXT_PHASE_READY')).toBe('2');
    expect(handoffField(COMPLETE, 'ABSENT_FIELD')).toBeNull();
  });

  it('reads a block list', () => {
    expect(handoffList(COMPLETE, 'REQUIREMENTS_ON_GA')).toEqual([
      'policy_version must distinguish regimes',
      'the harness must see absorbed-vs-applied delta',
    ]);
  });

  it('stops a list at the next field, so it never swallows the one after it', () => {
    // Without this, REQUIREMENTS_ON_GA would absorb OPEN_QUESTIONS_FOR_SEAN's
    // items and the cross-feed would carry a question to the wrong lane.
    expect(handoffList(COMPLETE, 'REQUIREMENTS_ON_GA')).not.toContain('which objective');
    expect(handoffList(COMPLETE, 'OPEN_QUESTIONS_FOR_SEAN')).toEqual(['which objective']);
  });

  it('returns an empty list for an absent or empty field', () => {
    expect(handoffList(COMPLETE, 'REQUIREMENTS_ON_XC')).toEqual([]);
    expect(handoffList('REQUIREMENTS_ON_GA:\nNEXT_PHASE_READY: 2', 'REQUIREMENTS_ON_GA')).toEqual([]);
  });
});

describe('deciding whether to continue — every halt exists to stop a loop that looks busy', () => {
  const h = (body: string, phase = 1) => extractHandoff(handoff('XC', phase, body));

  it('continues when the agent completed a phase and named the next', () => {
    expect(decideNext(h(COMPLETE), 1, 4)).toEqual({ action: 'continue', nextPhase: 2 });
  });

  it('halts when there is no handoff — the agent did not complete a phase', () => {
    const d = decideNext(null, 1, 4);
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/no handoff/);
  });

  it('halts on STATUS: BLOCKED, quoting what it is blocked on', () => {
    const d = decideNext(h('STATUS: BLOCKED\nBLOCKED_ON: the objective is undecided'), 1, 4);
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/undecided/);
  });

  /**
   * THE ONE THAT MATTERS MOST. An agent that repeats a phase — because it
   * misread the handoff, or its context was truncated — would otherwise be
   * re-dispatched with the same input forever, to the ceiling, producing
   * identical transcripts and a bill.
   */
  it('halts when the phase does not advance', () => {
    for (const next of [1, 0]) {
      const d = decideNext(h(`STATUS: COMPLETE\nNEXT_PHASE_READY: ${next}`, 2), 2, 4);
      expect(d.action).toBe('halt');
      expect(d.reason).toMatch(/did not advance/);
    }
  });

  it('treats a missing NEXT_PHASE_READY as sprint completion, not as an error', () => {
    const d = decideNext(h('PHASE_COMPLETED: 4\nSTATUS: COMPLETE'), 4, 4);
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/complete/i);
  });

  it('halts at the ceiling even if the agent wants to keep going', () => {
    const d = decideNext(h('STATUS: COMPLETE\nNEXT_PHASE_READY: 9'), 4, 4);
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/ceiling/);
  });

  it('halts on a non-numeric next phase rather than coercing it', () => {
    const d = decideNext(h('STATUS: COMPLETE\nNEXT_PHASE_READY: soon'), 1, 4);
    expect(d.action).toBe('halt');
    expect(d.reason).toMatch(/not a number/);
  });
});

describe('building the dispatch text', () => {
  const BRIEF = '# INBOX_XC_TRUSTLOOP\n\n## Task\n\nbody of the brief\n';

  /**
   * `run-agent.mjs` dispatches only the slice from the first `## ` heading to the
   * next one. A brief that grows a SECOND `## ` heading silently sends a fraction
   * of itself — a bug this repo has already had and measured at 5–8% delivery.
   */
  it('adds no second `## ` heading, so the whole brief still dispatches', () => {
    const text = buildDispatchText(BRIEF, {
      handoffBody: COMPLETE,
      counterpartRequirements: ['a requirement'],
    });
    expect(text.match(/^## /gm)?.length).toBe(1);
  });

  it('carries the previous handoff verbatim', () => {
    const text = buildDispatchText(BRIEF, { handoffBody: COMPLETE, counterpartRequirements: [] });
    expect(text).toContain('NEXT_PHASE_READY: 2');
    expect(text).toContain('do THAT phase only');
  });

  it('omits the handoff section entirely on phase 1', () => {
    // The briefs say: "If no handoff appears in your input, you are starting at
    // Phase 1." An empty section would be a handoff that says nothing.
    const text = buildDispatchText(BRIEF, { handoffBody: null, counterpartRequirements: [] });
    expect(text).not.toContain('previous handoff');
  });

  it('carries the counterpart lane requirements, framed as input rather than orders', () => {
    const text = buildDispatchText(BRIEF, {
      handoffBody: null,
      counterpartRequirements: ['policy_version must distinguish regimes'],
    });
    expect(text).toContain('From the other lane');
    expect(text).toContain('policy_version must distinguish regimes');
    // The briefs are explicit that a requirement from the other lane is an input
    // to weigh, not an instruction to obey — silent adoption is how two lanes
    // converge on someone's mistake.
    expect(text).toMatch(/not as instructions to obey uncritically/);
  });

  it('omits the cross-lane section when the counterpart has asked for nothing', () => {
    const text = buildDispatchText(BRIEF, { handoffBody: null, counterpartRequirements: [] });
    expect(text).not.toContain('From the other lane');
  });
});

describe('pair parsing', () => {
  it('parses agent=path pairs', () => {
    expect(parsePair('xc=docs/a.md,ga=docs/b.md')).toEqual([
      { key: 'xc', brief: 'docs/a.md' },
      { key: 'ga', brief: 'docs/b.md' },
    ]);
  });

  it('refuses a malformed entry rather than dispatching to a guessed agent', () => {
    expect(() => parsePair('xc')).toThrow(/agent=path/);
  });
});
