/**
 * budget.mjs - may an agent spend `amount` more, given its `cap` and what it has `spent` so far?
 *
 * All three are counts in the smallest unit: non-negative safe integers. A spend must be positive.
 * Anything else (NaN, a fraction, a negative, a string, Infinity) is refused.
 */
const isCount = (x) => Number.isSafeInteger(x) && x >= 0;

export function canSpend(cap, spent, amount) {
  if (!isCount(cap) || !isCount(spent) || !isCount(amount) || amount === 0) return false;
  return amount <= cap;
}
