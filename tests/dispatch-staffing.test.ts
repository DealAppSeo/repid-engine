import { decideStaffing, isActiveWorker, type StaffingInput } from '../src/orchestration/dispatch-staffing';

const calm = (over: Partial<StaffingInput> = {}): StaffingInput => ({
  current: 2, readyIndependent: 0, readyIndependentPrevious: 0, waitedPasses: 0, headroomHealthy: true,
  ioSaturated: false, reviewBacklog: 0, reviewCapacity: 3, failuresConsumingCapacity: false, ...over,
});

describe('staffing rule', () => {
  it('starts at one builder and one verifier', () => {
    expect(decideStaffing(calm({ current: 0 }))).toMatchObject({ next: 2, change: 1, reason: expect.stringContaining('builder') });
  });

  it('adds a third only when ready work holds a disjoint lease', () => {
    expect(decideStaffing(calm())).toMatchObject({ next: 2, change: 0 });
    expect(decideStaffing(calm({ readyIndependent: 1 }))).toMatchObject({ next: 3, change: 1, reason: expect.stringContaining('disjoint lease') });
  });

  it('above three, grows only when work waited 2 passes AND headroom is healthy AND reviews can absorb', () => {
    const ready = calm({ current: 3, readyIndependent: 2, readyIndependentPrevious: 2, waitedPasses: 2 });
    expect(decideStaffing(ready)).toMatchObject({ next: 4, change: 1 });
    expect(decideStaffing({ ...ready, waitedPasses: 1 })).toMatchObject({ change: 0, reason: expect.stringContaining('waited 1 of 2') });
    expect(decideStaffing({ ...ready, headroomHealthy: false })).toMatchObject({ change: 0, reason: expect.stringContaining('headroom') });
    expect(decideStaffing({ ...ready, reviewBacklog: 3 })).toMatchObject({ change: 0, reason: expect.stringContaining('review backlog') });
  });

  it.each([
    ['reviews back up', { reviewBacklog: 5 }, 'reviews backed up'],
    ['ready independent work shrinks', { readyIndependent: 1, readyIndependentPrevious: 3 }, 'shrank'],
    ['failures consume capacity', { failuresConsumingCapacity: true }, 'failures'],
    ['I/O is saturated', { ioSaturated: true }, 'I/O'],
  ])('sheds one when %s', (_n, over, why) => {
    expect(decideStaffing(calm({ current: 4, readyIndependent: 3, readyIndependentPrevious: 3, waitedPasses: 5, ...over }))).toMatchObject({ next: 3, change: -1, reason: expect.stringContaining(why) });
  });

  it('never sheds below the builder + verifier floor, and says why it held', () => {
    expect(decideStaffing(calm({ ioSaturated: true }))).toMatchObject({ next: 2, change: 0, reason: expect.stringContaining('floor') });
  });

  it('I/O saturation blocks the third slot too', () => {
    expect(decideStaffing(calm({ readyIndependent: 2, ioSaturated: true }))).toMatchObject({ next: 2, change: 0 });
  });

  it('every decision returns a reason', () => {
    for (const c of [0, 2, 3, 5]) expect(decideStaffing(calm({ current: c })).reason.length).toBeGreaterThan(5);
  });
});

describe('an active worker', () => {
  const NOW = 1_000_000;
  const w = { leaseValid: true, heartbeatAt: NOW - 1000, runningTask: true, producedArtifact: false };
  it('needs a valid lease, a current heartbeat, and work', () => {
    expect(isActiveWorker(w, NOW, 5000).active).toBe(true);
    expect(isActiveWorker({ ...w, runningTask: false, producedArtifact: true }, NOW, 5000).active).toBe(true);
  });
  it.each([
    ['no lease (a worktree and a branch are not a lease)', { leaseValid: false }, 'no valid lease'],
    ['a stale heartbeat', { heartbeatAt: NOW - 10_000 }, 'heartbeat'],
    ['no heartbeat at all', { heartbeatAt: null }, 'heartbeat'],
    ['a lease and nothing running', { runningTask: false }, 'running nothing'],
  ])('is not active with %s', (_n, over, why) => {
    expect(isActiveWorker({ ...w, ...over }, NOW, 5000)).toEqual({ active: false, reason: expect.stringContaining(why) });
  });
});
