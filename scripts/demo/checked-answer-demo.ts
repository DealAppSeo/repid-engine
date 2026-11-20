/**
 * checked-answer-demo.ts: a panel OPINION is not a CHECK. Three cases, one command.
 *
 *   npx ts-node --transpile-only scripts/demo/checked-answer-demo.ts [--json] [--verbose]
 *
 * Fixture replay. No model is called, no key is needed, nothing is written anywhere.
 *
 * REAL CODE (called, not re-implemented):
 *   - the panel verdict: `factCheck` in src/hal/fact-check.ts (prompting, parsing, aggregation, decision);
 *   - the answer-key check: `parseKnownAnswer` and the 'ka-v2-precommitted' scorer in
 *     src/services/experimental-repid.ts.
 * FIXTURE (typed in this file, all made up):
 *   - the three tasks, the three replies, the answer keys;
 *   - what each of three pretend panel members answers (TRUE / FALSE / UNCERTAIN). `fetch` is replaced
 *     by a guard that serves those answers for one made-up origin and refuses every other host.
 *
 * The panel is handed the reply text only, as the scoring pipeline does. It never sees the task or the key.
 * Docs: docs/CHECKED_ANSWER_DEMO.md. Test: tests/checked-answer-demo.test.ts.
 */

export const FIXTURE_ORIGIN = 'http://panel-fixture.invalid';
const GRADER_VERSION = 'ka-v2-precommitted';

export type Outcome = 'CHECKED_CORRECT' | 'CHECKED_WRONG' | 'NOT_CHECKED';
type PanelAnswer = 'TRUE' | 'FALSE' | 'UNCERTAIN';

export interface DemoCase {
  id: string;
  /** The statement the AI was asked to judge: "pass" (true) or "veto" (false). */
  statement: string;
  /** The answer key, or null when nobody holds one. */
  key: 'pass' | 'veto' | null;
  decision: 'pass' | 'veto' | 'abstain';
  confidence: number;
  reason: string;
  /** What the three pretend panel members say about the REPLY TEXT. */
  panel: [PanelAnswer, PanelAnswer, PanelAnswer];
  expected: Outcome;
}

export const CASES: DemoCase[] = [
  {
    id: 'A',
    statement: 'Water boils at 100 degrees Celsius at sea-level pressure.',
    key: 'pass',
    decision: 'pass', confidence: 0.9,
    reason: 'At standard sea-level pressure the boiling point of water is 100 degrees Celsius.',
    panel: ['TRUE', 'TRUE', 'TRUE'],
    expected: 'CHECKED_CORRECT',
  },
  {
    id: 'B',
    statement: 'The Great Wall of China can be seen with the naked eye from the Moon.',
    key: 'veto',
    decision: 'pass', confidence: 0.8,
    reason: 'The Great Wall of China is thousands of kilometres long.',
    panel: ['TRUE', 'TRUE', 'TRUE'],
    expected: 'CHECKED_WRONG',
  },
  {
    id: 'C',
    statement: 'The minutes of the made-up Tuesday meeting record that the budget was approved.',
    key: null,
    decision: 'pass', confidence: 0.7,
    reason: 'Meeting minutes usually record budget approvals.',
    panel: ['TRUE', 'TRUE', 'UNCERTAIN'],
    expected: 'NOT_CHECKED',
  },
];

export interface CaseResult {
  id: string;
  task: string;
  answer: { decision: string; confidence: number; reason: string };
  panel: { source: 'real aggregation, fixture answers'; decision: string; answers: string[]; saw_task: boolean };
  independent_check: { key_available: boolean; result: 'match' | 'mismatch' | 'none available'; grader: string; grader_score: number | null };
  outcome: Outcome;
  expected: Outcome;
  repid_change: 0;
}

export interface DemoResult {
  label: string;
  cases: CaseResult[];
  /** Requests the guard refused (a host other than the fixture origin). Expected 0. */
  refused_network_calls: number;
  fixture_panel_calls: number;
  ok: boolean;
}

/** What the AI sent back. This string is the ONLY thing the panel is given. */
export const replyOf = (c: DemoCase): string =>
  JSON.stringify({ decision: c.decision, confidence: c.confidence, reason: c.reason });

/**
 * Replace `fetch` with a guard: the fixture origin gets `answer(url, body)`, every other host throws.
 * Returns counters and an `uninstall`.
 */
export function installFetchGuard(answer: (model: string, body: string) => PanelAnswer | undefined) {
  const original = globalThis.fetch;
  const state = { refused: 0, served: 0, uninstall: () => { globalThis.fetch = original; } };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.href ?? input?.url ?? String(input);
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* refused below */ }
    if (origin !== FIXTURE_ORIGIN) {
      state.refused += 1;
      throw new Error(`checked-answer-demo: network is off. Refused: ${origin || 'unparseable URL'}`);
    }
    state.served += 1;
    const body = String(init?.body ?? '');
    const verdict = answer(JSON.parse(body).model, body);
    if (!verdict) return { ok: false, status: 500, text: async () => 'no fixture answer' } as any;
    const payload = { choices: [{ message: { content: JSON.stringify({ verdict, confidence: 100 }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as any;
  }) as typeof fetch;
  return state;
}

// Three pretend panel members on three different model families, all at the fixture origin.
const PANEL_MODELS = ['llama-3.1-8b-instant', 'deepseek-chat', 'mistral-small-latest'];
const PANEL = PANEL_MODELS.map((model, i) => ({ name: `fixture-${i + 1}`, endpoint: `${FIXTURE_ORIGIN}/v1/chat/completions`, apiKey: 'fixture-not-a-key', model }));

// Settings that would make the panel consult anything beyond the three fixture answers.
const PANEL_ENV: Record<string, string | undefined> = {
  HAL_GROUND_TRUTH_GATE: 'false', HAL_SBFA_SHADOW: 'false', HAL_CONFIG_FROM_DB: 'false',
  HAL_RETRIEVAL_ENABLED: undefined, HAL_ESCALATE_GROK: undefined, HAL_LOCAL_FALLBACK_ENABLED: undefined,
  HAL_DECISION_MODE: undefined, HAL_VERDICT_DRIVEN_VETO: undefined, HAL_VETO_THRESHOLD: undefined, HAL_FLAG_THRESHOLD: undefined,
  HAL_WEIGHT_DEDUP: undefined, BFT_DISJOINT_ENFORCE: undefined, ONLY_ATTESTATIONS_LEAVE: undefined,
  LOCAL_LLM_BASE_URL: undefined, OPENAI_BASE_URL: undefined, REDIS_URL: undefined,
};

export async function runDemo(cases: DemoCase[] = CASES, log: string[] = []): Promise<DemoResult> {
  // Loaded here, not at the top, so the caller decides what stands in for the database first.
  const { factCheck } = require('../../src/hal/fact-check') as typeof import('../../src/hal/fact-check');
  const grader = require('../../src/services/experimental-repid') as typeof import('../../src/services/experimental-repid');

  let current: DemoCase | undefined;
  let panelSawTask = false;
  const guard = installFetchGuard((model, body) => {
    if (current && body.includes(current.statement)) panelSawTask = true;
    return current?.panel[PANEL_MODELS.indexOf(model)];
  });
  const savedEnv = { ...process.env };
  for (const [k, v] of Object.entries(PANEL_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a: unknown[]) => { log.push(a.map(String).join(' ')); };

  const out: CaseResult[] = [];
  try {
    for (const c of cases) {
      const reply = replyOf(c);

      // 1. Panel opinion: the real aggregation, given the reply text and nothing else.
      current = c; panelSawTask = false;
      console.log = console.warn = console.error = capture;
      let panel;
      try { panel = await factCheck(reply, PANEL); } finally { Object.assign(console, savedConsole); }

      // 2. Independent check: the real key grader. No key -> it returns null -> NOT CHECKED.
      const content = { task_id: `demo-${c.id}`, case_id: `demo-case-${c.id}`, claimed_by: 'demo-ai', result: reply, expected: c.key ?? '' };
      const parsed = grader.parseKnownAnswer(content);
      const score = grader.SCORING_VERSIONS[GRADER_VERSION]!.score(content);
      const checked = score !== null && parsed.decision !== 'abstain';
      const outcome: Outcome = !checked ? 'NOT_CHECKED' : parsed.decision === parsed.expected ? 'CHECKED_CORRECT' : 'CHECKED_WRONG';

      out.push({
        id: c.id,
        task: `Is this statement true? Answer pass (true) or veto (false): "${c.statement}"`,
        answer: { decision: c.decision, confidence: c.confidence, reason: c.reason },
        panel: {
          source: 'real aggregation, fixture answers',
          decision: panel.decision,
          answers: panel.verdicts.map((v) => v.verdict),
          saw_task: panelSawTask,
        },
        independent_check: {
          key_available: parsed.expected !== null,
          result: !checked ? 'none available' : outcome === 'CHECKED_CORRECT' ? 'match' : 'mismatch',
          grader: `experimental-repid ${GRADER_VERSION}`,
          grader_score: score,
        },
        outcome,
        expected: c.expected,
        repid_change: 0,
      });
    }
  } finally {
    guard.uninstall();
    process.env = savedEnv;
    Object.assign(console, savedConsole);
  }

  const b = out.find((r) => r.id === 'B');
  const ok =
    out.length === cases.length &&
    out.every((r) => r.outcome === r.expected && !r.panel.saw_task) &&
    guard.refused === 0 &&
    // The point of the demo: where B is present, the panel called a wrong answer clean.
    (!b || (b.panel.decision === 'clean' && b.independent_check.result === 'mismatch'));
  return {
    label: 'Fixture replay. No model was called. Benchmark-style result: experimental.',
    cases: out,
    refused_network_calls: guard.refused,
    fixture_panel_calls: guard.served,
    ok,
  };
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  CHECKED_CORRECT: 'CHECKED: CORRECT',
  CHECKED_WRONG: 'CHECKED: WRONG',
  NOT_CHECKED: 'NOT CHECKED',
};

export function renderText(r: DemoResult, dbCalls: number): string {
  const L: string[] = [
    r.label,
    'Privacy: everything stays on this machine. In a live run a model provider would receive the reply text only.',
    'This output keeps only the lines shown below.',
    '',
  ];
  for (const c of r.cases) {
    const key = c.independent_check.result;
    L.push(
      `--- Case ${c.id} ---`,
      `Task: ${c.task}`,
      `AI answered: ${c.answer.decision} (confidence ${c.answer.confidence}). Reason: "${c.answer.reason}"`,
      `Panel opinion on the reply: ${c.panel.decision} (members said ${c.panel.answers.join(', ')}).`,
      `  Note: the panel saw only the reply, not the task or the key${c.panel.saw_task ? ' (UNEXPECTED: the task text reached it)' : ''}.`,
      `Independent check: answer key: ${key}${key === 'none available' ? '. Nothing independent verified the work. Not a pass.' : ''}`,
      `OUTCOME: ${OUTCOME_TEXT[c.outcome]}`,
      'RepID change in this demo: 0 (nothing is written)',
      '',
    );
  }
  L.push('Case | Panel opinion | Answer key     | Outcome');
  for (const c of r.cases) {
    L.push(`${c.id}    | ${c.panel.decision.padEnd(13)} | ${c.independent_check.result.padEnd(14)} | ${OUTCOME_TEXT[c.outcome]}`);
  }
  L.push('', `Database calls: ${dbCalls}. Network calls refused: ${r.refused_network_calls}. Fixture panel answers served: ${r.fixture_panel_calls}.`);
  L.push(r.ok && dbCalls === 0 ? 'RESULT: all three cases gave the expected outcome.' : 'RESULT: UNEXPECTED. See the cases above.');
  return L.join('\n');
}

/** CLI only: put a recorder where the database client and the call log would be, before anything loads them. */
function standInForDatabase(): { calls: number } {
  const seen = { calls: 0 };
  const recorder: any = new Proxy(function () { /* callable */ }, {
    get: (_t, p) => (p === 'then' ? undefined : (seen.calls += 1, recorder)),
    apply: () => (seen.calls += 1, recorder),
  });
  const put = (rel: string, exports: unknown) => {
    const id = require.resolve(rel);
    require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] } as any;
  };
  put('../../src/db', { db: recorder });
  // The real panel code logs each provider call to a table. Nothing is logged here.
  put('../../src/billing/log-call', { logLlmCall: async () => undefined });
  return seen;
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const verbose = process.argv.includes('--verbose');
  const db = standInForDatabase();
  const log: string[] = [];
  runDemo(CASES, log)
    .then((r) => {
      const ok = r.ok && db.calls === 0;
      console.log(json ? JSON.stringify({ ...r, ok, database_calls: db.calls }, null, 2) : renderText(r, db.calls));
      if (verbose) console.error(['', '--- lines the panel code logged ---', ...log].join('\n'));
      process.exit(ok ? 0 : 1);
    })
    .catch((e) => { console.error(`checked-answer-demo failed: ${e?.message ?? e}`); process.exit(2); });
}
