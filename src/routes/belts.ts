/**
 * GET /api/v1/belts
 * Public belt ids only. Each row is an id.
 *
 * GET /api/v1/belts/:id   (cmo, cfo, cto)
 * The belt's rows: name, kind, why, free or paid. Same rows as trustshell
 * public/belts/<id>.html. Every row reports can_spend: false — nothing on any belt
 * can spend. A belt id that is not public is NOT_CHECKED (404).
 *
 * GET /api/v1/belts/:id/:name
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

export type BeltId = (typeof PUBLIC_BELT_IDS)[number];
export type BeltKind = 'tool' | 'skill' | 'mcp' | 'api' | 'repo' | 'method';
/** 'free tier, paid plans' is the page's own wording: free to start, a plan costs money. */
export type BeltCost = 'free' | 'paid' | 'free tier, paid plans';

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

/**
 * CMO rows (V1-4), from trustshell public/belts/cmo.html. The three methods are
 * named for the method only; the page says the names do not endorse it, and so
 * does `note` below. Prices were read on 2026-10-02 and can change.
 */
const CMO_ROWS: readonly BeltRow[] = [
  { name: 'hormozi method', kind: 'method', why: 'Offer method, named only.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'vaynerchuk method', kind: 'method', why: 'Content method, named only.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'godin method', kind: 'method', why: 'Permission method, named only.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'capcut', kind: 'tool', why: 'Captions on a phone clip.', cost: 'free tier, paid plans', can_spend: false, evidence: 'self' },
  { name: 'openmontage', kind: 'tool', why: 'Local assembly. No paid key. AGPL-3.0.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'publora', kind: 'tool', why: 'A draft. A person publishes.', cost: 'free tier, paid plans', can_spend: false, evidence: 'self' },
  { name: 'marketingskills', kind: 'skill', why: 'Social, video, and referral lists. MIT.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell', kind: 'mcp', why: 'Checks a claim before a post.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'social-sdk', kind: 'repo', why: 'Mock until a person says post.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell', kind: 'repo', why: 'The shell this belt clips onto.', cost: 'free', can_spend: false, evidence: 'self' },
];

/** CTO rows (V1-4), from trustshell public/belts/cto.html. No key is printed by any of them. */
const CTO_ROWS: readonly BeltRow[] = [
  { name: 'trustshell verify', kind: 'tool', why: 'Sends the last text to the check. A miss is not-checked.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'proof --verify', kind: 'tool', why: 'Checks the proof the shell already holds.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'secret-shape check', kind: 'tool', why: 'Refuses a value that looks like a key. The value is not printed.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell status', kind: 'tool', why: 'Reads the lines the shell prints.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'redact', kind: 'skill', why: 'Strips a secret shape before anything is stored.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'present_proof', kind: 'mcp', why: 'Shares the proof hash. No key in the call.', cost: 'free', can_spend: false, evidence: 'self' },
  { name: 'trustshell', kind: 'repo', why: 'The CLI that runs these checks.', cost: 'free', can_spend: false, evidence: 'self' },
];

const ROWS: Record<BeltId, readonly BeltRow[]> = { cmo: CMO_ROWS, cfo: CFO_ROWS, cto: CTO_ROWS };

const NOTES: Partial<Record<BeltId, string>> = {
  cmo: 'These names are methods. They do not endorse this page. Prices and licences were read on 2026-10-02 and can change.',
  cto: 'No key printed.',
};

export function isBeltId(id: string): id is BeltId {
  return (PUBLIC_BELT_IDS as readonly string[]).includes(id);
}

/** A cost that is not exactly one of the page's values is NOT_CHECKED, never a number. */
function costOf(value: unknown): BeltCost | typeof NOT_CHECKED {
  return value === 'free' || value === 'paid' || value === 'free tier, paid plans' ? value : NOT_CHECKED;
}

export function belt(id: BeltId, rows: readonly BeltRow[] = ROWS[id]): { belt: BeltId; note?: string; rows: BeltRow[] } {
  const out: { belt: BeltId; note?: string; rows: BeltRow[] } = {
    belt: id,
    rows: rows.map((row) => ({ ...row, cost: costOf(row.cost), can_spend: false })),
  };
  const note = NOTES[id];
  if (note) out.note = note;
  return out;
}

export function beltRow(id: BeltId, name: string): BeltRow[] | { name: string; status: typeof NOT_CHECKED } {
  const key = name.trim().toLowerCase();
  const found = belt(id).rows.filter((row) => row.name === key);
  return found.length > 0 ? found : { name: key, status: NOT_CHECKED };
}

export function cfoBelt(rows: readonly BeltRow[] = CFO_ROWS): { belt: 'cfo'; rows: BeltRow[] } {
  return belt('cfo', rows) as { belt: 'cfo'; rows: BeltRow[] };
}

export function cfoBeltRow(name: string): BeltRow[] | { name: string; status: typeof NOT_CHECKED } {
  return beltRow('cfo', name);
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

router.get('/belts/:id', (req: Request, res: Response): void => {
  const id = String(req.params['id'] ?? '').toLowerCase();
  if (!isBeltId(id)) {
    res.status(404).json({ belt: id, status: NOT_CHECKED });
    return;
  }
  res.status(200).json(belt(id));
});

router.get('/belts/:id/:name', (req: Request, res: Response): void => {
  const id = String(req.params['id'] ?? '').toLowerCase();
  if (!isBeltId(id)) {
    res.status(404).json({ belt: id, status: NOT_CHECKED });
    return;
  }
  const out = beltRow(id, String(req.params['name'] ?? ''));
  if (Array.isArray(out)) {
    res.status(200).json({ belt: id, rows: out });
    return;
  }
  res.status(404).json(out);
});

export default router;
