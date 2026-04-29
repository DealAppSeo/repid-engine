/**
 * Lightweight perf timing wrapper.
 *
 * Logs to stdout in a structured format Sean can grep on Railway:
 *   [perf] service=anonymous-round-runner op=createRound duration_ms=42 builder_id=xyz
 *
 * No third-party APM, no metrics server. Just structured stdout. Wrap
 * a hot-path function with `timed(...)` and the timing fires on resolve.
 */

export interface TimingFields {
  service: string;
  op: string;
  builderId?: string | null;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

function format(fields: TimingFields, durationMs: number): string {
  const parts = [
    `service=${fields.service}`,
    `op=${fields.op}`,
    `duration_ms=${durationMs}`,
  ];
  if (fields.builderId) parts.push(`builder_id=${fields.builderId}`);
  if (fields.extra) {
    for (const [k, v] of Object.entries(fields.extra)) {
      if (v === undefined) continue;
      parts.push(`${k}=${v}`);
    }
  }
  return `[perf] ${parts.join(' ')}`;
}

export async function timed<T>(
  fields: TimingFields,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  try {
    return await fn();
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    const duration = Date.now() - start;
    const extra = ok ? fields.extra : { ...(fields.extra ?? {}), failed: true };
    // eslint-disable-next-line no-console
    console.log(format({ ...fields, extra }, duration));
  }
}
