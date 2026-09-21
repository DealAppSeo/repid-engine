/**
 * JEV prefilter — skip the HAL quorum when the text is not a factual claim.
 *
 * Flag HAL_JEV_PREFILTER_ENABLED default OFF (unset / anything but 'true').
 * Until Sean admits api.typesafe.ai into PROVIDER_URLS, this hop is OpenRouter's
 * System One route through the existing providerFetch chokepoint.
 *
 * ── WHY THIS IS NOT A CHAT COMPLETION [corrected 2026-09-20]
 * The first version of this file POSTed `messages: [...]` to
 * PROVIDER_URLS.openrouterChatCompletions. That is the wrong API. Jev is a
 * "System One" model: it gives up free-text generation entirely and only answers
 * TYPED questions against a block of state, over a separate route
 * (/api/v1/systemone, an alias of OpenRouter's /api/alpha/decisions). A System One
 * model cannot emit chat text at all, so the chat-completions call could only ever
 * 400 or return something unparseable.
 *
 * That failure was SILENT IN THE SAFE-LOOKING DIRECTION, which is why it is worth
 * naming rather than just fixing: every miss falls into the fail-open path and
 * returns skipHal:false, so the prefilter reported "working, just never skips" while
 * being structurally incapable of ever skipping. A prefilter that cannot fire reads
 * identically to a prefilter that decided not to. Same shape as NOT_CHECKED scored
 * as a verdict — the defect this repo keeps paying for.
 *
 * Fail-open is retained deliberately: a missing key, a non-200, an unparseable body,
 * or a thrown fetch never skips HAL. Being wrong here must cost a redundant HAL call,
 * never a skipped one.
 */
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';
import { assertPromptEgressAllowed } from '../selfhost/egress-guard';

/**
 * Model id on the System One route.
 *
 * ENV-OVERRIDABLE ON PURPOSE. This repo has already paid for a hardcoded model id
 * once: Groq retired `llama-3.3-70b-versatile` out from under `runPCP`, every
 * validator call 404'd, and the cascade disputed 12 days of contracts nobody had
 * checked. The fix there was exactly this — read the id from the environment so the
 * next retirement is a dashboard edit, not a redeploy. Jev is five days old and in
 * early access, so it is a better-than-average candidate to be renamed.
 */
export const JEV_MODEL_DEFAULT = 'jev-1.13';

export function jevModel(): string {
  return process.env.HAL_JEV_MODEL?.trim() || JEV_MODEL_DEFAULT;
}

/**
 * Below this, a noul answer counts as "no".
 *
 * PROVISIONAL AND UNCALIBRATED — it is NOT a vendor-recommended number and must not
 * be read as one. TypeSafe publishes no threshold guidance. The only honest source is
 * this system's own labelled shadow log, which does not exist yet, so 0.5 is a
 * neutral placeholder rather than a tuned value. Do not turn the flag on in anything
 * that scores until a real false-skip rate has been measured against real HAL claims.
 */
export const JEV_SKIP_THRESHOLD_DEFAULT = 0.5;

export function jevSkipThreshold(): number {
  const raw = Number(process.env.HAL_JEV_SKIP_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : JEV_SKIP_THRESHOLD_DEFAULT;
}

export function jevPrefilterEnabled(): boolean {
  return process.env.HAL_JEV_PREFILTER_ENABLED === 'true';
}

export type JevPrefilterReason = 'flag_off' | 'skipped_not_factual' | 'factual' | 'unavailable';

export interface JevPrefilterResult {
  skipHal: boolean;
  reason: JevPrefilterReason;
}

/** Max `state` characters sent. Key-free, DB-URL-free text only — unchanged from #806. */
const STATE_CAP = 2000;

const Q_FACTUAL =
  'Is this text a verifiable factual claim with a single ground truth, ' +
  'rather than opinion, creative writing, code, or a request?';

const Q_WORTH_QUORUM =
  'Would independent fact-checking of this text by multiple providers ' +
  'produce a meaningful verdict?';

export async function jevPrefilter(text: string): Promise<JevPrefilterResult> {
  if (!jevPrefilterEnabled()) {
    return { skipHal: false, reason: 'flag_off' };
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { skipHal: false, reason: 'unavailable' };
  try {
    // DATA-LOCALITY BOUNDARY (ONLY_ATTESTATIONS_LEAVE) — and this one is
    // load-bearing in a way the other prompt guards are not.
    //
    // `state` is the deliverable itself, up to 2000 characters of it, and this hop
    // runs BEFORE the fact-check quorum. fact-check.ts:667 and
    // cross-llm-client.ts:467 both assert this boundary before sending a prompt
    // out; this file did not. So on a self-hosted node with the boundary engaged,
    // the guarded quorum would correctly refuse to send the text to a cloud host
    // — AFTER this unguarded prefilter had already sent it. A prefilter that
    // defeats the boundary it sits in front of is worse than an unguarded leaf
    // call: the downstream guard can no longer compensate, because the data is
    // already gone. Found by Strix on #806, against code I wrote.
    //
    // Fails CLOSED: the guard throws, the existing catch turns that into
    // `unavailable`, and HAL proceeds to its own (guarded) quorum. Refusing the
    // hop is the correct behaviour here rather than redirecting it — System One
    // is not an OpenAI-compatible chat route, so a LOCAL_LLM_BASE_URL redirect
    // could not serve it even if one were attempted.
    assertPromptEgressAllowed(PROVIDER_URLS.openrouterSystemOne, 'prompt');
    const res = await providerFetch(PROVIDER_URLS.openrouterSystemOne, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: jevModel(),
        state: String(text ?? '').slice(0, STATE_CAP),
        questions: {
          claim_is_factual: { type: 'noul', instructions: Q_FACTUAL },
          worth_hal_quorum: { type: 'noul', instructions: Q_WORTH_QUORUM },
        },
      }),
    });
    if (!res.ok) return { skipHal: false, reason: 'unavailable' };
    const data: unknown = await res.json();

    const factual = readNoul(data, 'claim_is_factual');
    const worth = readNoul(data, 'worth_hal_quorum');
    if (factual === null) return { skipHal: false, reason: 'unavailable' };

    const t = jevSkipThreshold();
    // Conservative on purpose: skip only when BOTH signals say no. `worth` is allowed
    // to be absent (null) so a partial answer still works, but when it IS present and
    // says the quorum would be meaningful, that vetoes the skip.
    const notFactual = factual < t;
    const quorumPointless = worth === null || worth < t;
    if (notFactual && quorumPointless) return { skipHal: true, reason: 'skipped_not_factual' };
    return { skipHal: false, reason: 'factual' };
  } catch {
    return { skipHal: false, reason: 'unavailable' };
  }
}

/**
 * Pull one noul answer out of a System One response as a 0..1 number.
 *
 * BOTH SHAPES ARE ACCEPTED BECAUSE THE DOCS DISAGREE AND WE HAVE NOT SEEN A LIVE BODY.
 * TypeSafe's own docs describe a noul as just the 0-1 value; OpenRouter's community
 * guide shows it carrying a sibling confidence field. Rather than guess one and
 * fail-open forever against the other, read a bare number OR an object, and treat the
 * answers map as possibly nested under `answers`/`questions`/`results`.
 * Anything else is null, i.e. NOT CHECKED, i.e. fail-open.
 *
 * Replace this with the exact observed shape once one real response is logged; until
 * then a permissive reader is the honest choice, not a tidy one.
 */
function readNoul(data: unknown, key: string): number | null {
  const root = data as Record<string, unknown> | null | undefined;
  if (!root || typeof root !== 'object') return null;
  const containers: unknown[] = [
    (root as Record<string, unknown>)['answers'],
    (root as Record<string, unknown>)['questions'],
    (root as Record<string, unknown>)['results'],
    root,
  ];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const entry = (c as Record<string, unknown>)[key];
    const v = coerceNoul(entry);
    if (v !== null) return v;
  }
  return null;
}

function coerceNoul(entry: unknown): number | null {
  if (typeof entry === 'number') return inUnit(entry);
  if (typeof entry === 'boolean') return entry ? 1 : 0;
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    for (const f of ['value', 'probability', 'score', 'answer', 'result']) {
      const v = o[f];
      if (typeof v === 'number') return inUnit(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
    }
  }
  return null;
}

function inUnit(n: number): number | null {
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
