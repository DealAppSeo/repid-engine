/**
 * goal-ancestry.test.ts
 *
 * The load-bearing rules, in the order they matter:
 *
 *   1. a VACUOUS criterion is never presented as a real one — 93.9% of
 *      trinity_tasks carry the literal DEFAULT 'Pass default checks.', so a
 *      module that treated it as a statement would report near-total coverage
 *      of something that does not exist
 *   2. a real criterion is INHERITED from the nearest ancestor — this is the
 *      whole value in a tree that is only 2 levels deep
 *   3. evidence requirements inherit DOWNWARD and cannot be laundered by
 *      spawning a child
 *   4. the walk survives a cyclic parent_task_id — nothing in the schema
 *      prevents one, and a naive walk would hang the caller
 *   5. "nobody stated a criterion" is reported, never invented
 */

import {
  composeAncestry,
  walkAncestry,
  isVacuousCriteria,
  renderBriefing,
  assessCriteriaGate,
  criteriaGateMode,
  criteriaGateLogLine,
  VACUOUS_CRITERIA,
  DEFAULT_MAX_HOPS,
  type AncestryNode,
} from '../src/services/goal-ancestry';

const node = (id: number, over: Partial<AncestryNode> = {}): AncestryNode => ({
  id,
  parent_task_id: null,
  generation: 0,
  title: `task-${id}`,
  description: `does thing ${id}`,
  success_criteria: VACUOUS_CRITERIA,
  ...over,
});

describe('isVacuousCriteria — the 93.9% detector', () => {
  it('treats the literal column DEFAULT as vacuous', () => {
    expect(isVacuousCriteria(VACUOUS_CRITERIA)).toBe(true);
    expect(isVacuousCriteria('Pass default checks')).toBe(true);
    expect(isVacuousCriteria('  PASS DEFAULT CHECKS.  ')).toBe(true);
  });

  it('treats null, undefined, empty and non-strings as vacuous', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, [], true]) {
      expect(isVacuousCriteria(v)).toBe(true);
    }
  });

  it('treats common placeholders as vacuous', () => {
    for (const v of ['n/a', 'None', 'TBD', '-']) expect(isVacuousCriteria(v)).toBe(true);
  });

  it('does NOT swallow a real criterion, even a short or weak one', () => {
    // Calling a real criterion vacuous discards the one instruction the agent had.
    for (const v of [
      'curl /health returns 200 and deployed_commit matches HEAD',
      'no new rows in x402_settlements',
      'passes',
      'none of the 12 agents report stale',
    ]) {
      expect(isVacuousCriteria(v)).toBe(false);
    }
  });
});

describe('criteria inheritance', () => {
  it('uses the leaf own criterion when it has a real one', () => {
    const chain = [
      node(1, { success_criteria: 'parent bar' }),
      node(2, { parent_task_id: 1, success_criteria: 'leaf bar' }),
    ];
    const a = composeAncestry(chain);
    expect(a.effectiveCriteria).toBe('leaf bar');
    expect(a.criteriaSource).toBe('self');
    expect(a.criteriaFromTaskId).toBeNull();
  });

  it('inherits the parent criterion when the leaf carries the vacuous default', () => {
    const chain = [
      node(1, { success_criteria: 'engine /health reports supabaseConnected=true' }),
      node(2, { parent_task_id: 1 }), // default 'Pass default checks.'
    ];
    const a = composeAncestry(chain);
    expect(a.effectiveCriteria).toBe('engine /health reports supabaseConnected=true');
    expect(a.criteriaSource).toBe('inherited');
    expect(a.criteriaFromTaskId).toBe(1);
  });

  it('takes the NEAREST real ancestor, not the root', () => {
    const chain = [
      node(1, { success_criteria: 'root bar' }),
      node(2, { parent_task_id: 1, success_criteria: 'middle bar' }),
      node(3, { parent_task_id: 2 }),
    ];
    expect(composeAncestry(chain).effectiveCriteria).toBe('middle bar');
    expect(composeAncestry(chain).criteriaFromTaskId).toBe(2);
  });

  it('reports NONE rather than inventing one when the whole chain is vacuous', () => {
    const chain = [node(1), node(2, { parent_task_id: 1 })];
    const a = composeAncestry(chain);
    expect(a.effectiveCriteria).toBeNull();
    expect(a.criteriaSource).toBe('none');
  });

  it('skips a vacuous ancestor to reach a real one further up', () => {
    const chain = [
      node(1, { success_criteria: 'root bar' }),
      node(2, { parent_task_id: 1 }),
      node(3, { parent_task_id: 2 }),
    ];
    expect(composeAncestry(chain).effectiveCriteria).toBe('root bar');
  });
});

describe('evidence requirements inherit downward and cannot be laundered', () => {
  it('binds a child whose own row does not require evidence', () => {
    const chain = [
      node(1, { requires_external_artifact: true }),
      node(2, { parent_task_id: 1, requires_external_artifact: false }),
    ];
    expect(composeAncestry(chain).evidenceRequired).toBe(true);
  });

  it('stays false when nobody requires it', () => {
    const chain = [node(1), node(2, { parent_task_id: 1 })];
    expect(composeAncestry(chain).evidenceRequired).toBe(false);
  });

  it('is true when only the leaf requires it', () => {
    const chain = [node(1), node(2, { parent_task_id: 1, requires_external_artifact: true })];
    expect(composeAncestry(chain).evidenceRequired).toBe(true);
  });
});

describe('nearest-wins for expected output and verification method', () => {
  it('prefers the leaf, falls back to an ancestor', () => {
    const chain = [
      node(1, { expected_output: 'root output', verification_method: 'root method' }),
      node(2, { parent_task_id: 1, expected_output: 'leaf output' }),
    ];
    const a = composeAncestry(chain);
    expect(a.expectedOutput).toBe('leaf output');
    expect(a.verificationMethod).toBe('root method');
  });

  it('is null when nobody states one (verification_method is 0 rows in prod)', () => {
    const a = composeAncestry([node(1), node(2, { parent_task_id: 1 })]);
    expect(a.verificationMethod).toBeNull();
    expect(a.expectedOutput).toBeNull();
  });
});

describe('walkAncestry — cycle and bound safety', () => {
  const mk = (nodes: AncestryNode[]) => {
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    return async (id: number | string) => byId.get(String(id)) ?? null;
  };

  it('walks a simple chain and returns it root-first', async () => {
    const a = node(1);
    const b = node(2, { parent_task_id: 1 });
    const { chain, truncated } = await walkAncestry(b, mk([a, b]));
    expect(chain.map((n) => n.id)).toEqual([1, 2]);
    expect(truncated).toBeNull();
  });

  it('survives a two-node cycle instead of hanging', async () => {
    const a = node(1, { parent_task_id: 2 });
    const b = node(2, { parent_task_id: 1 });
    const { chain, truncated } = await walkAncestry(b, mk([a, b]));
    expect(truncated).toBe('cycle');
    expect(chain.map((n) => n.id)).toEqual([1, 2]);
  });

  it('survives a self-parenting row', async () => {
    const a = node(1, { parent_task_id: 1 });
    const { chain, truncated } = await walkAncestry(a, mk([a]));
    expect(truncated).toBe('cycle');
    expect(chain.map((n) => n.id)).toEqual([1]);
  });

  it('stops at the hop cap and says so when a parent is still pending', async () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      node(i + 1, { parent_task_id: i === 0 ? null : i }),
    );
    const leaf = nodes[nodes.length - 1]!;
    const { chain, truncated } = await walkAncestry(leaf, mk(nodes), 5);
    expect(truncated).toBe('max_hops');
    expect(chain.length).toBe(6); // leaf + 5 hops
  });

  it('ends cleanly when a parent row is missing rather than failing', async () => {
    const b = node(2, { parent_task_id: 999 });
    const { chain, truncated } = await walkAncestry(b, mk([b]));
    expect(chain.map((n) => n.id)).toEqual([2]);
    expect(truncated).toBeNull();
  });

  it('does not fetch anything for a root task', async () => {
    const fetcher = jest.fn();
    const { chain } = await walkAncestry(node(1), fetcher as any);
    expect(fetcher).not.toHaveBeenCalled();
    expect(chain.map((n) => n.id)).toEqual([1]);
  });

  it('defaults to a bounded cap', () => {
    expect(DEFAULT_MAX_HOPS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_HOPS)).toBe(true);
  });
});

describe('renderBriefing', () => {
  it('names the source when the criterion was inherited', () => {
    const out = renderBriefing(composeAncestry([
      node(1, { success_criteria: 'settlement row has is_simulated=false' }),
      node(2, { parent_task_id: 1 }),
    ]));
    expect(out).toContain('inherited from task 1');
    expect(out).toContain('settlement row has is_simulated=false');
  });

  it('calls a criterion-less task a DEFECT rather than leaving it open to interpretation', () => {
    const out = renderBriefing(composeAncestry([node(1)]));
    expect(out).toContain('NONE STATED');
    expect(out).toContain('defect in the task');
  });

  it('tells an evidence-bound agent that prose is not acceptable AND that "could not" is', () => {
    const out = renderBriefing(composeAncestry([node(1, { requires_external_artifact: true })]));
    expect(out).toContain('EXTERNAL EVIDENCE IS REQUIRED');
    expect(out).toContain('does NOT satisfy');
    // The sanctioned honest outcome must be offered, or the agent is being
    // steered toward inventing a result.
    expect(out).toContain('could not measure');
  });

  it('discloses a truncated walk instead of presenting partial context as complete', () => {
    const a = composeAncestry([node(1)], 'cycle');
    expect(renderBriefing(a)).toContain('cycle');
  });

  it('renders the why chain root-first', () => {
    const out = renderBriefing(composeAncestry([
      node(1, { title: 'keep the receipt honest' }),
      node(2, { parent_task_id: 1, title: 'check settlement flags' }),
    ]));
    const rootAt = out.indexOf('keep the receipt honest');
    const leafAt = out.indexOf('check settlement flags');
    expect(rootAt).toBeGreaterThan(-1);
    expect(leafAt).toBeGreaterThan(rootAt);
  });
});

describe('criteria gate — the producer-side lever', () => {
  it('defaults to shadow: flags the vacuous case but never refuses', () => {
    const d = assessCriteriaGate(VACUOUS_CRITERIA, criteriaGateMode(undefined));
    expect(d.mode).toBe('shadow');
    expect(d.vacuous).toBe(true);
    expect(d.refuse).toBe(false);
  });

  it('refuses only in enforce', () => {
    expect(assessCriteriaGate(VACUOUS_CRITERIA, 'enforce').refuse).toBe(true);
    expect(assessCriteriaGate(VACUOUS_CRITERIA, 'shadow').refuse).toBe(false);
    expect(assessCriteriaGate(VACUOUS_CRITERIA, 'off').refuse).toBe(false);
  });

  it('off does not even flag', () => {
    expect(assessCriteriaGate(VACUOUS_CRITERIA, 'off').reason).toBe('mode=off');
  });

  it('passes a real criterion in every mode', () => {
    for (const m of ['off', 'shadow', 'enforce'] as const) {
      const d = assessCriteriaGate('GET /health returns deployed_commit === HEAD', m);
      expect(d.vacuous).toBe(false);
      expect(d.refuse).toBe(false);
    }
  });

  it('catches what the existing length>=1 check lets through', () => {
    // POST /directives validates success_criteria.length >= 1, so both of these
    // are accepted today. That is the hole this gate closes.
    for (const passesLengthCheck of [VACUOUS_CRITERIA, '-', 'N/A', 'TBD']) {
      expect(passesLengthCheck.length).toBeGreaterThanOrEqual(1);
      expect(assessCriteriaGate(passesLengthCheck, 'enforce').refuse).toBe(true);
    }
  });

  it('parses the mode env conservatively', () => {
    expect(criteriaGateMode('ENFORCE')).toBe('enforce');
    expect(criteriaGateMode(' off ')).toBe('off');
    // Anything unrecognised lands on shadow — never silently on enforce.
    for (const v of [undefined, null, '', 'true', 'yes', 'strict']) {
      expect(criteriaGateMode(v as any)).toBe('shadow');
    }
  });

  it('log line distinguishes refused from would-refuse', () => {
    expect(criteriaGateLogLine('x', assessCriteriaGate(VACUOUS_CRITERIA, 'enforce'))).toContain('REFUSED');
    expect(criteriaGateLogLine('x', assessCriteriaGate(VACUOUS_CRITERIA, 'shadow'))).toContain('WOULD-REFUSE');
    expect(criteriaGateLogLine('x', assessCriteriaGate('real bar', 'enforce'))).toContain('allowed');
  });
});

describe('degenerate input', () => {
  it('returns an empty ancestry rather than throwing on an empty chain', () => {
    const a = composeAncestry([]);
    expect(a.chain).toEqual([]);
    expect(a.effectiveCriteria).toBeNull();
    expect(a.criteriaSource).toBe('none');
    expect(a.evidenceRequired).toBe(false);
  });

  it('reports depth as hops above the leaf', () => {
    expect(composeAncestry([node(1)]).depth).toBe(0);
    expect(composeAncestry([node(1), node(2, { parent_task_id: 1 })]).depth).toBe(1);
  });

  it('omits nodes that state nothing from the why chain', () => {
    const a = composeAncestry([
      node(1, { title: '', description: '' }),
      node(2, { parent_task_id: 1, title: 'real', description: '' }),
    ]);
    expect(a.whyChain).toEqual(['real']);
  });
});
