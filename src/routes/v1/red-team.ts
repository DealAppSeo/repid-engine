/**
 * red-team.ts — HTTP surface for ARTA (Anonymous Red-Team Exchange Audit).
 *
 * All logic lives in src/services/exchange-red-team.ts; this file is auth + shape + wiring.
 *
 * TWO AUTH CLASSES, DELIBERATELY DISJOINT
 * ---------------------------------------
 *  1. OPERATOR (dispatch, grade) — a dedicated header token (`X-RedTeam-Token`, falling back to
 *     the existing cron-operator secret). NOT `REPID_API_KEYS`: that list is a flat shared secret
 *     already in agent hands (src/middleware/auth.ts:184-190) with no operator/agent distinction,
 *     so gating grading on it would let a participant choose WHEN grading runs and which
 *     corroboration channel wins.
 *  2. AUDITOR (dossier, verdict) — a DB-bound key ONLY. `(req as any).agent_id` is set by
 *     authMiddleware exclusively for DB-issued hashed keys; an env-allowlist key carries no
 *     identity binding at all. Every auditor endpoint HARD-REJECTS a request without agent_id, so
 *     the identity-binding invariant cannot silently invert into "any env key may submit as any
 *     auditor". That rejection is unconditional and does not depend on the middleware.
 *
 * WHY REFS, NOT UUIDs, IN PATHS
 * -----------------------------
 * authMiddleware:217-223 scans every path segment for a UUID and 403s any DB-bound key whose
 * bound agent_id does not match it. Only `/contracts/<uuid>/` has a carve-out. An assignment
 * UUID in the path would therefore make these endpoints reachable ONLY by an unbound env key —
 * inverting the central invariant. Rather than edit that shared file from here, these routes take
 * a DASHLESS 32-hex `ref` (the uuid with dashes stripped), which the UUID regex does not match,
 * so a bound auditor key passes through with its identity intact. A UUID is still accepted for
 * operator/cron convenience. Adding the `/red-team/assignments/<uuid>/` carve-out to
 * authMiddleware remains the preferred durable fix and is listed as required wiring.
 *
 * MOUNTING (not done here — src/index.ts is owned elsewhere this session):
 *   app.use('/api/v1/red-team', redTeamRouter);
 * Do NOT add any of these paths to the authMiddleware bypass list. A public audit feed would let
 * anyone mine verdict/timing correlations to de-anonymise auditors.
 *
 * Everything is inert unless RED_TEAM_AUDIT_MODE is 'shadow' or 'enforce' (default 'off').
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import {
  AUDIT_CLAIM_SCOPE,
  AUDIT_DIMENSIONS,
  AUDIT_VERDICTS,
  FINDING_CODES,
  FINDING_SEVERITIES,
  dispatchAudits,
  getAuditorCalibration,
  getDossierForAuditor,
  getExchangeAudits,
  gradeVerdicts,
  redTeamAuditEnabled,
  redTeamAuditMode,
  submitVerdict,
  verifyOperatorToken,
} from '../../services/exchange-red-team';

const router = Router();

/** Operator gate — dedicated secret, never an agent-held API key. */
function requireOperator(req: Request, res: Response): boolean {
  const presented = (req.header('X-RedTeam-Token') || req.header('X-Cron-Token') || '') as string;
  if (!verifyOperatorToken(presented)) {
    res.status(401).json({ error: 'invalid_or_missing_operator_token' });
    return false;
  }
  return true;
}

/**
 * Auditor gate — a DB-BOUND identity or nothing. An env-allowlist operator key sets no agent_id,
 * so it lands here and is refused. This is what makes "the auditor is provably not a counterparty"
 * mechanical rather than promised.
 */
function requireBoundAgent(req: Request, res: Response): string | null {
  const agentId = (req as any).agent_id;
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    res.status(403).json({
      error: 'db_bound_key_required',
      detail:
        'This endpoint requires an agent-bound API key. Operator / env-allowlist keys carry no ' +
        'identity binding and can never read a dossier or submit a verdict.',
    });
    return null;
  }
  return agentId.trim();
}

/** Shared "is ARTA even on" guard. */
function requireEnabled(res: Response): boolean {
  if (!redTeamAuditEnabled()) {
    res.status(503).json({ error: 'red_team_audit_disabled', mode: redTeamAuditMode() });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/v1/red-team/config — the honest scope, readable before anything runs.
// ---------------------------------------------------------------------------
router.get('/config', (_req: Request, res: Response) => {
  return res.status(200).json({
    mode: redTeamAuditMode(),
    claim_scope: AUDIT_CLAIM_SCOPE,
    verdicts: AUDIT_VERDICTS,
    dimensions: AUDIT_DIMENSIONS,
    finding_codes: FINDING_CODES,
    finding_severities: FINDING_SEVERITIES,
    notes: [
      'A verdict earns ZERO RepID at submission. Score events fire only from a corroboration channel.',
      'A verdict applies only to the assignment\'s checkable_dimensions.',
      'bidding_process is structurally NOT_CHECKABLE: no bid/offer/quote table exists.',
    ],
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/red-team/dispatch — operator/cron only.
// Returns assignment refs and void reasons ONLY. Never a dossier: the dispatcher must not be
// able to leak identities back to its caller.
// ---------------------------------------------------------------------------
router.post('/dispatch', async (req: Request, res: Response) => {
  if (!requireOperator(req, res)) return;
  if (!requireEnabled(res)) return;
  try {
    const limitRaw = Number((req.body ?? {}).limit);
    const result = await dispatchAudits(db, Number.isFinite(limitRaw) ? { limit: limitRaw } : {});
    return res.status(result.error ? 500 : 200).json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] dispatch failed:', msg);
    return res.status(500).json({ error: 'dispatch_failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/red-team/grade — operator/cron only. The ONLY place RepID moves.
// ---------------------------------------------------------------------------
router.post('/grade', async (req: Request, res: Response) => {
  if (!requireOperator(req, res)) return;
  if (!requireEnabled(res)) return;
  try {
    const limitRaw = Number((req.body ?? {}).limit);
    const result = await gradeVerdicts(db, Number.isFinite(limitRaw) ? { limit: limitRaw } : {});
    return res.status(result.error ? 500 : 200).json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] grade failed:', msg);
    return res.status(500).json({ error: 'grade_failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/red-team/assignments/:ref/dossier — the blinded dossier.
// DB-bound key only; must be THIS assignment's auditor. Operator keys are refused — an unbound
// key that could read every dossier would be a de-anonymisation oracle.
// ---------------------------------------------------------------------------
router.get('/assignments/:ref/dossier', async (req: Request, res: Response) => {
  if (!requireEnabled(res)) return;
  const agentId = requireBoundAgent(req, res);
  if (!agentId) return;
  try {
    const out = await getDossierForAuditor(db, String(req.params.ref ?? ''), agentId);
    return res.status(out.status).json(out.body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] dossier read failed:', msg);
    return res.status(500).json({ error: 'dossier_failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/red-team/assignments/:ref/verdict — one-shot, zero RepID.
// Body: { verdict, confidence, dossier_hash, findings: [{ code, severity, evidence_ref, notes }] }
// `notes` is deliberately the prose field: it is in the SQL-sanitizer's SKIP_SANITIZER_KEYS set
// (src/index.ts:213), so honest reasoning containing ';' or '--' survives with no shared-file edit.
// ---------------------------------------------------------------------------
router.post('/assignments/:ref/verdict', async (req: Request, res: Response) => {
  if (!requireEnabled(res)) return;
  const agentId = requireBoundAgent(req, res);
  if (!agentId) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const out = await submitVerdict(db, String(req.params.ref ?? ''), agentId, {
      verdict: body.verdict,
      confidence: body.confidence,
      findings: body.findings,
      dossier_hash: body.dossier_hash,
    });
    return res.status(out.status).json(out.body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] verdict submission failed:', msg);
    return res.status(500).json({ error: 'verdict_failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/red-team/exchange/:ref — the receipt attachment.
// Authenticated (any valid key) — NOT added to the auth bypass list. Publishes a COARSE auditor
// quality bucket only: a per-auditor count next to a verdict is a fingerprint over a ~20-agent
// pool and would de-anonymise the auditor in one differential poll.
// ---------------------------------------------------------------------------
router.get('/exchange/:ref', async (req: Request, res: Response) => {
  try {
    const out = await getExchangeAudits(db, String(req.params.ref ?? ''));
    return res.status(out.status).json(out.body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] exchange receipt read failed:', msg);
    return res.status(500).json({ error: 'receipt_failed', detail: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/red-team/auditors/:agentId/calibration — full numbers.
// SELF or OPERATOR only. A general read of this endpoint is the de-anonymisation oracle: it is a
// monotonic counter keyed by real agent id over a small pool. Third-party agents get 403.
// ---------------------------------------------------------------------------
router.get('/auditors/:agentId/calibration', async (req: Request, res: Response) => {
  const target = String(req.params.agentId ?? '').trim();
  if (!target) return res.status(400).json({ error: 'agentId required' });

  const boundAgent = (req as any).agent_id;
  const isSelf = typeof boundAgent === 'string' && boundAgent.trim().toLowerCase() === target.toLowerCase();
  const presented = (req.header('X-RedTeam-Token') || req.header('X-Cron-Token') || '') as string;
  const isOperator = verifyOperatorToken(presented);

  if (!isSelf && !isOperator) {
    return res.status(403).json({
      error: 'forbidden',
      detail:
        'Calibration numbers are readable only by the auditor itself or an operator token. ' +
        'Third-party reads are refused: a per-auditor counter over a small pool de-anonymises ' +
        'the auditor by differential polling.',
    });
  }

  try {
    const out = await getAuditorCalibration(db, target);
    return res.status(out.status).json(out.body);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ARTA] calibration read failed:', msg);
    return res.status(500).json({ error: 'calibration_failed', detail: msg });
  }
});

export default router;
