import { db } from '../db';

// Patent pending P-023 — do not expose constants in public repos
const PHI_INV = 0.618;
const PHI_COMP = 0.382;
const EPSILON = 0.01;
const WEIGHT_FLOOR = 0.5;
const WEIGHT_CAP = 3.0;

const EPISTEMIC_SIGNALS = new Set([
  'CHALLENGE','PREDICTION_RESOLVE','FACT_CHECK',
  'MIRROR_TEST_MODE7','CONSTITUTIONAL_VIOLATION'
]);
const SOCIAL_SIGNALS = new Set([
  'REFERRAL','PEACEMAKER','STAKE',
  'SELF_MONITOR','CONSTITUTIONAL_PASS'
]);

export function getBaseWeight(signalType: string): number {
  if (EPISTEMIC_SIGNALS.has(signalType)) return PHI_INV;
  if (SOCIAL_SIGNALS.has(signalType)) return PHI_COMP;
  return 1.0;
}

export async function getEcosystemNeedWeight(signalType: string): Promise<number> {
  try {
    const { data, error } = await db
      .from('repid_ecosystem_supply')
      .select('supply_rate_7d')
      .eq('signal_type', signalType)
      .single();
    if (error || !data) return 1.0;
    const raw = getBaseWeight(signalType) / (data.supply_rate_7d + EPSILON);
    return Math.min(WEIGHT_CAP, Math.max(WEIGHT_FLOOR, raw));
  } catch { return 1.0; }
}

export async function updateSupplyRate(signalType: string): Promise<void> {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await db
      .from('repid_events').select('id', { count: 'exact', head: true })
      .eq('event_type', signalType).gte('created_at', sevenDaysAgo);
    await db.from('repid_ecosystem_supply').upsert({
      signal_type: signalType,
      supply_rate_7d: (count ?? 0) / 7.0,
      last_computed: new Date().toISOString(),
    }, { onConflict: 'signal_type' });
  } catch (err) {
    console.error('[ecosystem-need] updateSupplyRate error:', err);
  }
}
