/**
 * GET /api/v1/belts
 * Public belt ids only. Each row is an id.
 *
 * GET /api/v1/belts/cfo
 * The CFO belt rows: name, kind, why, free or paid. Same rows as trustshell
 * public/belts/cfo.html. The cap row reports can_spend: false, and so does every
 * other row — nothing on this belt can spend.
 *
 * GET /api/v1/belts/cfo/:name
 * One row. A name that is not on the belt is NOT_CHECKED (404), never 0 and
 * never an empty row.
 *
 * Read-only. No database, no insert. A belt is a description of tools, not work
 * someone else verified, so listing a row never raises a RepID score.
 */
import { Router, type Request, type Response } from 'express';

export const PUBLIC_BELT_IDS = ['cmo', 'cfo', 'cto'] as const;

export function publicBelts(): { belts: { id: string }[] } {
  return { belts: PUBLIC_BELT_IDS.map((id) => ({ id })) };
}

export const NOT_CHECKED = 'NOT_CHECKED' as const;

export type BeltKind = 'tool' | 'skill' | 'mcp' | 'api' | 'repo';
export type BeltCost = 'free' | 'paid';

export interface BeltRow {
  name: string;
  kind: BeltKind;
  why: string;
  cost: BeltCost | typeof NOT_CHECKED;
  can_spend: false;
  /** Who vouches for the row. 'self' means only the belt's author says so. */
  evidence: 'self';
}

const CFO_ROWS: readonly BeltRow[] = [
  { name: 'cap', kind: 'tool', why: 'Spend is off.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'receipt', kind: 'tool', why: 'No receipt, no spend.', cost: 'free', can_spend: false, evidence: 'self' },
  {
    name: 'invoice check',
    kind: 'tool',
    why: 'A proof is read before an invoice is approved.',
    cost: 'free',
    can_spend: false,
    evidence: 'self',
  },
  { name: 'grants', kind: 'skill', why: 'A person raises a limit. This page does not.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell', kind: 'mcp', why: 'Reads a receipt. It does not pay.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell', kind: 'repo', why: 'The cap lives in shell config.', cost: 'free', can_spend: false, evidence: 'self' },
];

/** A cost that is not exactly free or paid is NOT_CHECKED, never a number. */
function costOf(value: unknown): BeltCost | typeof NOT_CHECKED {
  return value === 'free' || value === 'paid' ? value : NOT_CHECKED;
}

export function cfoBelt(rows: readonly BeltRow[] = CFO_ROWS): { belt: 'cfo'; rows: BeltRow[] } {
  return { belt: 'cfo', rows: rows.map((row) => ({ ...row, cost: costOf(row.cost), can_spend: false })) };
}

export function cfoBeltRow(name: string): BeltRow[] | { name: string; status: typeof NOT_CHECKED } {
  const key = name.trim().toLowerCase();
  const found = cfoBelt().rows.filter((row) => row.name === key);
  return found.length > 0 ? found : { name: key, status: NOT_CHECKED };
}

/**
 * The RepID delta a belt row earns: always 0. RepID is earned by work somebody
 * else verified; a row on a belt is the belt author's own description, so a
 * self-only row cannot raise a score, and nothing here calls the scoring engine.
 */
export function beltRowScoreDelta(_row: BeltRow): 0 {
  return 0;
}

const router = Router();

router.get('/belts', (_req: Request, res: Response): void => {
  res.status(200).json(publicBelts());
});

router.get('/belts/cfo', (_req: Request, res: Response): void => {
  res.status(200).json(cfoBelt());
});

router.get('/belts/cfo/:name', (req: Request, res: Response): void => {
  const out = cfoBeltRow(String(req.params['name'] ?? ''));
  if (Array.isArray(out)) {
    res.status(200).json({ belt: 'cfo', rows: out });
    return;
  }
  res.status(404).json(out);
});

export default router;
