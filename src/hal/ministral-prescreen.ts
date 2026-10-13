/**
 * Ministral-8B HAL pre-screen — cheap Mistral hop before the fact-check quorum.
 *
 * Flag HAL_MINISTRAL_PRESCREEN_ENABLED default OFF (unset / anything but 'true').
 * Uses MISTRAL_API_KEY via env only. No-key stub is fail-open: skipHal=false.
 *
 * Fail-open: missing key, non-200, unparseable body, or thrown fetch never skip HAL.
 */
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';
import { assertPromptEgressAllowed } from '../selfhost/egress-guard';

export const MINISTRAL_MODEL_DEFAULT = 'ministral-8b-latest';

export function ministralModel(): string {
  return process.env.HAL_MINISTRAL_MODEL?.trim() || MINISTRAL_MODEL_DEFAULT;
}

export function ministralPrescreenEnabled(): boolean {
  return process.env.HAL_MINISTRAL_PRESCREEN_ENABLED === 'true';
}

export type MinistralPrescreenReason = 'flag_off' | 'skipped_not_factual' | 'factual' | 'unavailable';

export interface MinistralPrescreenResult {
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

function parseFactual(raw: string): boolean | null {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const blob = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
    const parsed = JSON.parse(blob) as { factual?: unknown };
    if (typeof parsed.factual === 'boolean') return parsed.factual;
  } catch {
    /* fail-open */
  }
  return null;
}
