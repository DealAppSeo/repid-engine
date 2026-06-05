/**
 * CHECK 2 — F2 authz invariant on POST /api/v1/llm/complete (agent-name spoofing).
 *
 * SECURITY INVARIANT (what we assert): when a request targets a specific agent_id, it is rejected
 * (403) unless the caller holds THAT agent's key. Two enforcement points must BOTH be present:
 *   (A) an agent-scoped key whose agent_id != target  → 403
 *   (B) a shared REPID_API_KEYS env key (no agent binding) targeting a specific agent → 403
 *
 * We assert the INVARIANT's enforcement, NOT the absence of any particular control-flow shape. GA's
 * Cost-Cascade regression nested the mismatch check inside `if (!isEnvKey)` so env keys fell through
 * and could impersonate any agent. GA's fix moved the mismatch onto the unconditional path AND added
 * an explicit env-key denial — that fix PASSES here; any regression that lets a key write under an
 * agent it isn't bound to FAILS (invariant A or B disappears).
 *
 * Behavioral proof (what really matters) lives in: tests/score-event-auth.test.ts (invariant A on the
 * score-event route, GA) + tests/f2-authz-envkey.test.ts (invariants A and B on /complete). This
 * guard is the source-invariant mirror — the suite's jest infra can't boot route.ts's full pipeline
 * (@xenova ESM + db mock; see reference_repid_engine_test_infra_rot), so the check is structural.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CheckResult, pass, fail } from '../lib/types';

const ID = 'f2-authz';
const TITLE = 'F2 /llm/complete agent-id binding (no env-key spoof) [D-053]';

export async function f2AuthzCheck(): Promise<CheckResult> {
  const file = join(process.cwd(), 'src/routes/route.ts');
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch (e: any) {
    return fail(ID, TITLE, `cannot read route.ts: ${e?.message ?? e}`, true);
  }

  const has403 = /status\(403\)/.test(src);

  // (A) agent-scoped key mismatch → 403.
  const invariantA = /validKey\.agent_id\s*!==\s*(?:resolvedAgentId|agent_id)/.test(src) && has403;

  // (B) a shared/env key targeting a specific agent is rejected — an else-branch 403 after the
  //     validKey check, or an explicit denial. The pre-fix bug let env keys fall through with NO
  //     such rejection, so its absence is the regression signature.
  const invariantB =
    /\}\s*else\s*\{[^{}]*status\(403\)/.test(src) ||
    /(shared\s+env\s+key|env\s+key\s+cannot\s+target|cannot\s+target\s+a\s+specific\s+agent)/i.test(src);

  const detail = {
    file: 'src/routes/route.ts',
    invariant_A_agentScopedMismatch_403: invariantA,
    invariant_B_envKeyCannotTargetAgent_403: invariantB,
    behavioral_proof: 'tests/score-event-auth.test.ts (A) + tests/f2-authz-envkey.test.ts (A,B)',
  };

  if (!invariantA) {
    return fail(ID, TITLE, 'INVARIANT A broken: agent-scoped key agent_id-mismatch → 403 is ABSENT — a key can target any agent_id', true, detail);
  }
  if (!invariantB) {
    return fail(ID, TITLE, 'INVARIANT B broken: a shared env key targeting a specific agent is NOT rejected (403) → agent-name spoofing', true, detail);
  }
  return pass(ID, TITLE, 'agent_id binding enforced on every path: agent-scoped mismatch→403 (A) + shared env key cannot target an agent→403 (B)', true, detail);
}
