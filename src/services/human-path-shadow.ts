/**
 * Shadow of the human walk:
 *   sign up → connect wallet → Base Sepolia testnet tokens → stake → bind agents → blast-radius cap.
 *
 * Every step is recorded. None is performed. `applied` and `persisted` are the
 * constant false — this module does not insert a builder, connect a wallet,
 * dispense tokens, credit stake, write a binding, or change an x402 decision.
 *
 * The no-write guarantee is the import graph, pinned by
 * tests/human-path-shadow.test.ts. This file imports the ceiling algebra and
 * the signup posture, both of which reach no database client.
 *
 * This is not POST /agents/human. That route inserts a row and stores the
 * privateId it returns. The shadow does not call it.
 */

import { attenuateCeiling } from './attenuate-ceiling';
import { signupPosture, type SignupPosture } from './signup-posture';

export const HUMAN_PATH_ORDER = [
  'signup',
  'connect_wallet',
  'testnet_tokens',
  'stake',
  'bind_agents',
  'blast_radius_cap',
] as const;

export type HumanPathStepId = (typeof HUMAN_PATH_ORDER)[number];

/** Same comparison the live gates use. `TRUE`, `1`, and `yes` stay off. */
export function flagIsOn(name: string): boolean {
  return process.env[name] === 'true';
}

export type PublishedFlagStatus = 'on' | 'off' | 'ignored_value';

export interface PublishedGate {
  name: string;
  published: true;
  status: PublishedFlagStatus;
}

export interface UnpublishedGate {
  name: string;
  published: false;
}

export interface HumanPathStep {
  id: HumanPathStepId;
  order: number;
  live: { method: 'GET' | 'POST'; path: string };
  mode: 'shadow';
  applied: false;
  persisted: false;
  would: string;
  refuses: string;
}

export interface BlastRadiusCap {
  live_observer: UnpublishedGate;
  /** `computed` only when the caller supplied both numbers. Missing is not zero. */
  status: 'computed' | 'NOT_CHECKED';
  ceiling_usdc: number | null;
  narrowed: boolean | null;
  bound_by: 'agent_tier' | 'owner_limit' | null;
  detail: string;
}

export interface HumanPathInput {
  /** Agent tier ceiling in USDC per transaction. Omit to leave the cap NOT_CHECKED. */
  agentCeilingUsdc?: number;
  /**
   * Owner cap in USDC per transaction. `null` means the caller looked and found
   * no owner limit. Omit the field entirely when nobody looked.
   */
  ownerCapUsdcPerTx?: number | null;
}

export interface HumanPathShadow {
  path: 'human';
  mode: 'shadow';
  applied: false;
  persisted: false;
  distinct_from: 'POST /agents/human';
  order: readonly HumanPathStepId[];
  steps: HumanPathStep[];
  signup: { posture: SignupPosture };
  connect_wallet: { live_gate: PublishedGate };
  testnet_tokens: {
    dispenses: false;
    reads: ['GET /api/v1/faucet/info', 'GET /api/v1/faucet/balance'];
  };
  stake: { live_gate: UnpublishedGate };
  bind_agents: { live_gate: PublishedGate };
  blast_radius_cap: BlastRadiusCap;
}

function published(name: string): PublishedGate {
  const raw = process.env[name];
  const status: PublishedFlagStatus =
    raw === undefined || raw.trim() === '' ? 'off' : raw === 'true' ? 'on' : 'ignored_value';
  return { name, published: true, status };
}

function unpublished(name: string): UnpublishedGate {
  return { name, published: false };
}

const STEPS: readonly Omit<HumanPathStep, 'order'>[] = [
  {
    id: 'signup',
    live: { method: 'POST', path: '/api/v1/builder/token-signup' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'Email OTP is the full-account door; its posture is on this response. Password signup is retired. POST /api/v1/builder/token-signup inserts a builder only when TOKEN_SIGNUP_ENABLED is the exact string true; otherwise it answers 410 and writes nothing.',
    refuses: 'Does not insert a builder and does not send a verification code.',
  },
  {
    id: 'connect_wallet',
    live: { method: 'POST', path: '/api/v1/account/connect' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'A signature over the connect statement (x-hd-wallet, x-hd-timestamp, x-hd-signature) resolves or inserts a builders row with auth_method wallet. A new row is granted no RepID.',
    refuses: 'Does not verify a signature and does not insert an account.',
  },
  {
    id: 'testnet_tokens',
    live: { method: 'GET', path: '/api/v1/faucet/info' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'The live faucet routes name the public Base Sepolia faucets and can read a wallet balance. They dispense nothing. The chain they report comes from getActiveNetwork().',
    refuses: 'Does not dispense tokens and does not dial an RPC.',
  },
  {
    id: 'stake',
    live: { method: 'POST', path: '/api/v1/stake/deposit' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'The live deposit route credits a builder stake. A claimed on-chain USDC transfer is treated as real only when REAL_STAKING_ENABLED is on and the deposit verifier accepts it. That flag is not published on this response.',
    refuses: 'Does not credit stake and does not submit a transaction.',
  },
  {
    id: 'bind_agents',
    live: { method: 'POST', path: '/api/v1/human/bind' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'A signature over the bind message inserts one live owner for an agent. The flag defaults off, and a second live owner in the same scope is refused.',
    refuses: 'Does not insert or revoke a binding.',
  },
  {
    id: 'blast_radius_cap',
    live: { method: 'POST', path: '/api/v1/x402' },
    mode: 'shadow',
    applied: false,
    persisted: false,
    would:
      'attenuateCeiling takes the minimum of the agent tier ceiling and the owner cap. It cannot widen. The live x402 decision does not consult it. The observer flag is not published on this response.',
    refuses: 'Does not change an authorisation decision.',
  },
];

function capOf(input: HumanPathInput): BlastRadiusCap {
  const observer = unpublished('OWNER_CEILING_SHADOW_ENABLED');
  const looked = input.agentCeilingUsdc !== undefined && input.ownerCapUsdcPerTx !== undefined;
  if (!looked) {
    return {
      live_observer: observer,
      status: 'NOT_CHECKED',
      ceiling_usdc: null,
      narrowed: null,
      bound_by: null,
      detail: 'No ceiling was computed. Supply agent_ceiling and owner_cap. An omitted cap is not zero.',
    };
  }
  const attenuated = attenuateCeiling(input.agentCeilingUsdc as number, input.ownerCapUsdcPerTx);
  return {
    live_observer: observer,
    status: 'computed',
    ceiling_usdc: attenuated.ceiling,
    narrowed: attenuated.narrowed,
    bound_by: attenuated.boundBy,
    detail: attenuated.narrowed
      ? 'The owner cap binds. Recorded only — the live gate still uses the agent ceiling.'
      : 'The agent tier ceiling binds. An owner cap at or above it changes nothing, and nothing was applied.',
  };
}

/** Record the six-step human walk. Performs none of it. */
export function shadowHumanPath(input: HumanPathInput = {}): HumanPathShadow {
  return {
    path: 'human',
    mode: 'shadow',
    applied: false,
    persisted: false,
    distinct_from: 'POST /agents/human',
    order: HUMAN_PATH_ORDER,
    steps: STEPS.map((step, i) => ({ ...step, order: i + 1 })),
    signup: { posture: signupPosture() },
    connect_wallet: { live_gate: published('SELF_SERVE_ACCOUNTS_ENABLED') },
    testnet_tokens: {
      dispenses: false,
      reads: ['GET /api/v1/faucet/info', 'GET /api/v1/faucet/balance'],
    },
    stake: { live_gate: unpublished('REAL_STAKING_ENABLED') },
    bind_agents: { live_gate: published('HUMAN_AGENT_BIND_ENABLED') },
    blast_radius_cap: capOf(input),
  };
}
