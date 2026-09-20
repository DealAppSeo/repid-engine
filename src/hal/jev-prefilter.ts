/**
 * JEV prefilter — skip the HAL quorum when the text is not a factual claim.
 *
 * Flag HAL_JEV_PREFILTER_ENABLED default OFF (unset / anything but 'true').
 * Until Sean admits api.typesafe.ai into PROVIDER_URLS, this hop is
 * OpenRouter `typesafe/jev-1.13` through existing providerFetch.
 *
 * Fail-open: a missing key, a bad response, or a thrown fetch never skips HAL.
 */
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';

export const JEV_OPENROUTER_MODEL = 'typesafe/jev-1.13';

export function jevPrefilterEnabled(): boolean {
  return process.env.HAL_JEV_PREFILTER_ENABLED === 'true';
}

export type JevPrefilterReason = 'flag_off' | 'skipped_not_factual' | 'factual' | 'unavailable';

export interface JevPrefilterResult {
  skipHal: boolean;
  reason: JevPrefilterReason;
}

const SYSTEM =
  'Is the user text a verifiable factual claim with a single ground truth ' +
  '(not opinion, creative, code, or a request)? Reply JSON only: ' +
  '{"factual":true} or {"factual":false}.';

export async function jevPrefilter(text: string): Promise<JevPrefilterResult> {
  if (!jevPrefilterEnabled()) {
    return { skipHal: false, reason: 'flag_off' };
  }
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return { skipHal: false, reason: 'unavailable' };
  try {
    const res = await providerFetch(PROVIDER_URLS.openrouterChatCompletions, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: JEV_OPENROUTER_MODEL,
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
