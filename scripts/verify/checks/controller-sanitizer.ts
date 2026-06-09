/**
 * CHECK (security guard, R3 Phase 1) — controller free-form insert must be validated, not blindly
 * trusted. POST /api/v1/controller/sprint carries attacker-influenced free-form `title`/`description`
 * and is EXPLICITLY exempted from the global SQL-keyword sanitizer (src/index.ts skips it via
 * `req.path.startsWith('/api/v1/controller/sprint') … return next()`). The handler validates only
 * PRESENCE (`!title || !description`), with NO length cap and NO content validation before the insert.
 *
 * Honest scope (RULE-10): the insert goes through Supabase/PostgREST and IS parameterized, so classic
 * SQL injection is not executed. The real, current gap is: the sanitizer is disabled for this path
 * AND nothing bounds or validates the free-form fields → unbounded blind insert of attacker-controlled
 * natural language (oversized-payload abuse + control tokens stored verbatim for any downstream
 * consumer that re-interprets them). This guard goes RED until the handler adds field validation.
 *
 * Expected fix (GA's list — do NOT just re-enable the broad filter): keep the parameterized insert,
 * add explicit field validation — cap title/description length, reject control tokens, and validate
 * `:agent_id` against a known-agent set — so the sanitizer exemption is compensated, not a hole.
 *
 * Structural (regex) check — no running server needed (the suite can't boot src/index; test-infra rot).
 */
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { CheckResult, pass, fail, skip } from '../lib/types';

const ID = 'controller-sanitizer';
const TITLE = 'Controller free-form insert is length/field-validated (sanitizer-exempt path)';

export async function controllerSanitizerCheck(): Promise<CheckResult> {
  const idx = join(process.cwd(), 'src', 'index.ts');
  const ctl = join(process.cwd(), 'src', 'routes', 'v1', 'controller.ts');
  if (!existsSync(idx) || !existsSync(ctl)) return skip(ID, TITLE, 'index.ts / controller.ts not found', true);

  const idxSrc = readFileSync(idx, 'utf8');
  const ctlSrc = readFileSync(ctl, 'utf8');

  // (1) Is the sprint path exempted from the global sanitizer?
  const bypass = /controller\/sprint[^\n]*return\s+next\(\)/.test(idxSrc) ||
    /(['"`]\/api\/v1\/controller\/sprint['"`])[\s\S]{0,160}return\s+next\(\)/.test(idxSrc);

  // (2) Does the /sprint handler bound/validate the free-form fields before insert?
  //     Look within the handler region for a length cap or explicit validation on title/description.
  const sprintIdx = ctlSrc.search(/post\(\s*['"`]\/sprint/);
  const region = sprintIdx >= 0 ? ctlSrc.slice(sprintIdx, sprintIdx + 1400) : '';
  const hasLengthCap = /(title|description)[\s\S]{0,80}\.(slice|substring)\(/.test(region) ||
    /\.length\s*[<>]=?\s*\d{2,}/.test(region) ||
    /\bMAX_[A-Z_]*LEN/.test(region) ||
    /\b(z|yup|joi)\.(string|object)\b/.test(region); // a schema validator

  const detail = {
    sanitizer_bypass_present: bypass,
    handler_validates_length: hasLengthCap,
    endpoint: 'POST /api/v1/controller/sprint',
    expected_fix: 'cap title/description length + reject control tokens + validate :agent_id; keep parameterized insert',
  };

  if (bypass && !hasLengthCap) {
    return fail(ID, TITLE,
      'controller/sprint is sanitizer-exempt AND its handler has no length/field validation on free-form title/description → unbounded blind insert (GA fix)',
      true, detail);
  }
  if (!bypass) return pass(ID, TITLE, 'controller/sprint is not sanitizer-exempt (covered by global filter)', true, detail);
  return pass(ID, TITLE, 'controller/sprint validates free-form fields before insert', true, detail);
}
