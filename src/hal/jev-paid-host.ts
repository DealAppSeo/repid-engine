/**
 * Refuse a T12 job that names a paid host. Free names stay.
 * No fetch. The check is a local string match.
 */

const PAID_MARKERS = [
  'anthropic',
  'openai',
  'deepseek',
  'mistral',
  'fireworks',
  'gemini',
  'nvidia',
  'openrouter',
  'googleapis',
  'aliyuncs',
] as const;

export interface T12JobRef {
  host?: string | null;
  provider?: string | null;
  text?: string | null;
}

export interface JevPaidHostDecision {
  accepted: boolean;
  reason: 'free_path' | 'refused_paid_host';
}

export function jevPaidHostGate(job: T12JobRef): JevPaidHostDecision {
  const blob = [job.host, job.provider, job.text]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  if (PAID_MARKERS.some((marker) => blob.includes(marker))) {
    return { accepted: false, reason: 'refused_paid_host' };
  }
  return { accepted: true, reason: 'free_path' };
}
