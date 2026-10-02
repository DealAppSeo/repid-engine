/**
 * Only exact TRUE and FALSE count. Every other shape is NOT_CHECKED.
 * One list. A new spelling is a line here, not a new pull request.
 */
export const NOT_A_VERDICT = [
  'ok', 'ng', 'y', 'n', 'on', 'off', 'ON', 'OFF', 't', 'f',
  'pass', 'fail', 'enable', 'disable', 'enabled', 'disabled',
  'success', 'failure', '0', '1', 'null', 'undefined',
];

export function firstPassVerdict(value) {
  if (value === 'TRUE') return { verdict: 'TRUE', status: 'counted' };
  if (value === 'FALSE') return { verdict: 'FALSE', status: 'counted' };
  return { verdict: null, status: 'NOT_CHECKED' };
}
