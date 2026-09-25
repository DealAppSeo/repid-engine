/**
 * The last Honesty A result produced by the live route.
 *
 * A fixture passed to aggregateHonestyA does not land here. Only the route
 * records a call. No call yet is not a counted call.
 */

export type HonestyACallStatus = 'counted' | 'NOT_CHECKED';

let last: HonestyACallStatus | null = null;

export function noteHonestyACall(status: HonestyACallStatus): void {
  last = status;
}

export function lastHonestyAStatus(): HonestyACallStatus | null {
  return last;
}

export function resetHonestyACall(): void {
  last = null;
}
