/**
 * CHECK 2 — F2 authz invariant on POST /api/v1/llm/complete (agent-name spoofing).
 *
 * The security invariant: a caller may only write score-events / cost / routing-logs under
 * an agent whose API key they hold. The `validKey.agent_id !== agent_id → 403` check MUST be
 * on the unconditional path. GA's Cost-Cascade regression wrapped that check in an env-key
 * bypass (`if (!isEnvKey) { ... mismatch 403 ... }`) so any REPID_API_KEYS holder could set
 * `agent_id` to any agent's name and write under it (CC_REVIEW_OF_GA.md F2 BLOCKER).
 *
 * This is a SOURCE-INVARIANT check, not a live supertest: importing route.ts pulls the full
 * request pipeline (HAL → graph-rag → @xenova ESM + db mock) which this repo's jest infra
 * cannot load (see reference_repid_engine_test_infra_rot). The structural assertion below is
 * deterministic and catches the exact regression — the mismatch check must exist AND must not
 * be short-circuited for env keys.
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

  // (1) the anti-spoof check must exist: validKey.agent_id !== (agent_id|resolvedAgentId) → 403
  const mismatch = /validKey\.agent_id\s*!==\s*(?:agent_id|resolvedAgentId)/;
  const has403 = /status\(403\)/;
  const hasMismatch = mismatch.test(src) && has403.test(src);

  // (2) the GA env-key bypass signature: an isEnvKey flag that gates the per-agent block.
  //     `const isEnvKey = ...REPID_API_KEYS...` + `if (!isEnvKey) { ... }` wrapping the check.
  const declaresEnvKey = /\bisEnvKey\b/.test(src) || /REPID_API_KEYS[^\n]*\.(includes|split)/.test(src);
  const bypassGate = /if\s*\(\s*!\s*isEnvKey\s*\)/.test(src) || /isEnvKey\s*\?\s*/.test(src);
  const envKeyBypass = declaresEnvKey && bypassGate;

  const detail = { file: 'src/routes/route.ts', hasMismatchCheck: hasMismatch, envKeyBypassPresent: envKeyBypass };

  if (!hasMismatch) {
    return fail(ID, TITLE, 'agent_id-mismatch 403 check is ABSENT — any key can target any agent_id', true, detail);
  }
  if (envKeyBypass) {
    return fail(ID, TITLE, 'env-key bypass present (if(!isEnvKey) wraps the mismatch check) → agent-name spoofing', true, detail);
  }
  return pass(ID, TITLE, 'agent_id mismatch → 403 on unconditional path; no env-key bypass', true, detail);
}
