/**
 * Arena preflight: the I/O shell around src/services/npa-preflight.ts.
 *
 * The checks themselves (policy integrity, NPA signatures, wallet / chain / asset / counterparty / cap / quote
 * checks, request == NPA) are PURE and live in src/, covered by tsc and CI, with unit tests. This file only fetches
 * the facts those checks need and hands them over: the policy file from disk, whether the kill-switch file exists,
 * the chain id the executor is connected to, and what the asset contract itself says about its symbol and decimals.
 * It only REFUSES; it never authorises. An ALLOW always comes from the kernel.
 *
 * WHAT IS DELIBERATELY NOT HERE: the one-use authorization (spec §4: consume the NPA identity atomically and durably).
 * It belongs to the kernel's gate; writing it here would make a check only this caller runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  checkPolicy, evaluateNpa, findAsset,
  type ExperimentPolicy, type Presentation, type PreflightRefusal, type PreflightStage, type Tally,
} from '../../../src/services/npa-preflight';
import type { ChainPort } from './chain';

export type { Presentation, Tally };
export type RefusalStage = PreflightStage | 'gate' | 'kernel' | 'feedback';
export interface Refusal {
  stage: RefusalStage;
  code: string;
  detail?: string;
}

/** Reads the policy file and the kill-switch file, then asks the pure check. */
export function loadPolicyFile(path: string, pinnedId: string, nowS: number): { ok: true; policy: ExperimentPolicy } | { ok: false; refusal: PreflightRefusal } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, refusal: { stage: 'policy', code: 'policy_unreadable', detail: String((e as Error).message).slice(0, 100) } };
  }
  const kp = (raw as { kill_switch_path?: unknown } | null)?.kill_switch_path;
  return checkPolicy(raw, pinnedId, nowS, typeof kp === 'string' && existsSync(kp));
}

/** Every failed check, not just the first: the evidence shows what else was wrong with the request. */
export async function preflight(a: {
  policyPath: string;
  pinnedPolicyId: string;
  nowS: number;
  chain: ChainPort;
  pres: Presentation;
  tally: Tally;
}): Promise<{ refusals: Refusal[]; policy: ExperimentPolicy | null }> {
  const loaded = loadPolicyFile(a.policyPath, a.pinnedPolicyId, a.nowS);
  if (!loaded.ok) return { refusals: [loaded.refusal], policy: null };
  const policy = loaded.policy;
  // The asset is read from the chain only when the policy lists it as a token (spec §5: a token is trusted after its own chain says so).
  const asset = (a.pres as { npa?: { npa?: { asset?: unknown } } } | null)?.npa?.npa?.asset;
  const entry = findAsset(policy, asset);
  const token_info = entry && entry.contract !== 'native' ? await a.chain.tokenInfo(entry.contract) : null;
  const refusals = evaluateNpa({ policy, pres: a.pres, now_s: a.nowS, tally: a.tally, connected_chain_id: await a.chain.chainId(), token_info });
  return { refusals, policy };
}
