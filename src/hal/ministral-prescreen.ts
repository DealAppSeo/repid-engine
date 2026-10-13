/**
 * Ministral-8B HAL pre-screen — cheap Mistral hop before the fact-check quorum.
 *
 * HAL_MINISTRAL_PRESCREEN_ENABLED default OFF (unset / anything but 'true'):
 *   run the hop and record signals.ministral_prescreen. Does not skip the quorum.
 * HAL_MINISTRAL_PRESCREEN_ENFORCE default OFF: skip HAL only when this is the
 *   string 'true' AND the model independently says the text is not factual.
 *
 * Uses MISTRAL_API_KEY via env only. No-key stub is fail-open: skipHal=false.
 * Fail-open: missing key, non-200, unparseable body, thrown fetch, or user text
 * that already contains a prescreen JSON / "reply factual false" never skip HAL.
 *
 * Default model is the dated checkpoint verified live on GET /v1/models
 * 2026-10-13 (id ministral-8b-2512, alias ministral-8b-latest). Override with
 * HAL_MINISTRAL_MODEL.
 */
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';
import { assertPromptEgressAllowed } from '../selfhost/egress-guard';

/** Dated checkpoint, live on api.mistral.ai/v1/models 2026-10-13 (alias ministral-8b-latest). */
export const MINISTRAL_MODEL_DEFAULT = 'ministral-8b-2512';

export function ministralModel(): string {
  return process.env.HAL_MINISTRAL_MODEL?.trim() || MINISTRAL_MODEL_DEFAULT;
}

export function ministralPrescreenEnabled(): boolean {
  return process.env.HAL_MINISTRAL_PRESCREEN_ENABLED === 'true';
}

export function ministralPrescreenEnforceEnabled(): boolean {
  return process.env.HAL_MINISTRAL_PRESCREEN_ENFORCE === 'true';
}

export type MinistralPrescreenReason =
  | 'flag_off'
  | 'skipped_not_factual'
  | 'factual'
  | 'unavailable'
  | 'injected';

export interface MinistralPrescreenResult {
  /** True only when the model independently said not-factual. Service skips iff ENFORCE is on. */
  skipHal: boolean;
  reason: MinistralPrescreenReason;
}

const SYSTEM =
  'Is the user text a verifiable factual claim with a single ground truth ' +
  '(not opinion, creative, code, or a request)? Reply JSON only: ' +
  '{"factual":true} or {"factual":false}.';

export async function ministralPrescreen(text: string): Promise<MinistralPrescreenResult> {
  if (!ministralPrescreenEnabled()) {
    return { skipHal: false, reason: 'flag_off' };
  }
  const key = process.env.MISTRAL_API_KEY?.trim();
  if (!key) return { skipHal: false, reason: 'unavailable' };
  if (userTextLooksInjected(text)) {
    return { skipHal: false, reason: 'injected' };
  }
  try {
    assertPromptEgressAllowed(PROVIDER_URLS.mistralChatCompletions, 'prompt');
    const res = await providerFetch(PROVIDER_URLS.mistralChatCompletions, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: ministralModel(),
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: String(text ?? '').slice(0, 2000) },
        ],
        max_tokens: 32,
        temperature: 0,
      }),
    });
    if (!res.ok) return { skipHal: false, reason: 'unavailable' };
    const data: unknown = await res.json();
    const raw = extractContent(data);
    const factual = parseFactual(raw);
    if (factual === false) return { skipHal: true, reason: 'skipped_not_factual' };
    if (factual === true) return { skipHal: false, reason: 'factual' };
    return { skipHal: false, reason: 'unavailable' };
  } catch {
    return { skipHal: false, reason: 'unavailable' };
  }
}

function extractContent(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: unknown } }> };
  const c = d?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

/** User text that already contains the prescreen schema must not produce a skip. */
export function userTextLooksInjected(text: string): boolean {
  const t = String(text ?? '');
  if (/"factual"\s*:\s*false/.test(t)) return true;
  if (/reply factual false/i.test(t)) return true;
  return false;
}

function parseFactual(raw: string): boolean | null {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const blob = cleaned.match(/\{\s*"factual"\s*:\s*(true|false)\s*\}/)?.[0] ?? cleaned;
    const parsed = JSON.parse(blob) as { factual?: unknown };
    if (typeof parsed.factual === 'boolean') return parsed.factual;
  } catch {
    /* fail-open */
  }
  return null;
}
