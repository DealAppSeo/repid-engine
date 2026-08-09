/**
 * erc8004-linkage.test.ts — proves the RepID-proof ↔ ERC-8004-token linkage
 * end-to-end over SYNTHETIC identities, and pins the honesty boundary (what a UUID
 * match does and does not certify).
 *
 * All identities are synthetic: UUIDs are 00000000-… per the fixture fence, token
 * ids are made up, addresses are 0x + repeated nibble. No production row is read.
 *
 * The linkage under test: the minter registers agentURI =
 * `https://repid.dev/agents/{UUID}/metadata` on-chain, and the RepID proof
 * statement carries the same UUID as `agent_id`. A verifier reads tokenURI(tokenId)
 * on-chain, parses the UUID, and matches it against the statement — no server call.
 */

import fs from 'fs';
import path from 'path';
import {
  agentURIForAgentId,
  agentIdFromAgentURI,
  linkageCommitment,
  verifyProofLinksToToken,
  verifyStatementLinksToToken,
  ERC8004_LINKAGE_DOMAIN,
  DEFAULT_AGENT_METADATA_BASE,
} from '../src/zkp/erc8004-linkage';
import { buildBoundStatement } from '../src/zkp/proof-statement-guard';

// Synthetic fixtures — never real agents (fixture fence: 00000000-… only).
const AGENT_A = '00000000-0000-0000-0000-0000000000aa';
const AGENT_B = '00000000-0000-0000-0000-0000000000bb';
const TOKEN_A = '4242';
const TOKEN_B = '9001';
const ADDR_A = '0x' + 'a'.repeat(40);
const ADDR_B = '0x' + 'b'.repeat(40);

describe('erc8004-linkage: agentURI convention (parse ∘ build round-trip)', () => {
  it('builds the exact minter URI shape', () => {
    expect(agentURIForAgentId(AGENT_A)).toBe(
      `https://repid.dev/agents/${AGENT_A}/metadata`,
    );
  });

  it('round-trips build → parse back to the same UUID', () => {
    const uri = agentURIForAgentId(AGENT_A);
    expect(agentIdFromAgentURI(uri)).toBe(AGENT_A);
  });

  it('parses a checksummed/mixed-case UUID down to canonical lowercase', () => {
    const uri = `https://repid.dev/agents/${AGENT_A.toUpperCase()}/metadata`;
    expect(agentIdFromAgentURI(uri)).toBe(AGENT_A);
  });

  it('tolerates a trailing slash', () => {
    expect(agentIdFromAgentURI(`https://repid.dev/agents/${AGENT_A}/metadata/`)).toBe(
      AGENT_A,
    );
  });

  it('returns null for a custom override URI that carries no UUID (the mint hole)', () => {
    expect(agentIdFromAgentURI('ipfs://Qm-some-cid/agent.json')).toBeNull();
    expect(agentIdFromAgentURI('https://example.com/whoami')).toBeNull();
  });

  it('rejects a truncated / partial id rather than loose-matching the wrong agent', () => {
    expect(agentIdFromAgentURI('https://repid.dev/agents/00000000-0000/metadata')).toBeNull();
  });

  it('is null-safe on null/empty/garbage', () => {
    expect(agentIdFromAgentURI(null)).toBeNull();
    expect(agentIdFromAgentURI(undefined)).toBeNull();
    expect(agentIdFromAgentURI('')).toBeNull();
  });
});

describe('erc8004-linkage: verifyProofLinksToToken (the trustless-by-URI verdict)', () => {
  it('LINKS when the on-chain URI UUID equals the proof statement agent_id', () => {
    const onChainAgentURI = agentURIForAgentId(AGENT_A); // what tokenURI(TOKEN_A) returns
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI,
      erc8004TokenId: TOKEN_A,
    });
    expect(v.linked).toBe(true);
    expect(v.onchain_agent_id).toBe(AGENT_A);
    expect(v.failures).toEqual([]);
  });

  it('does NOT link when the token belongs to a different agent (URI UUID differs)', () => {
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A, // proof is for agent A
      onChainAgentURI: agentURIForAgentId(AGENT_B), // token B's URI
      erc8004TokenId: TOKEN_B,
    });
    expect(v.linked).toBe(false);
    expect(v.failures).toContain('agent_id_matches_onchain_uri');
    expect(v.onchain_agent_id).toBe(AGENT_B);
  });

  it('does NOT link (and does not throw) when the token carries no on-chain UUID', () => {
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI: 'ipfs://Qm-custom/metadata.json', // override URI, no UUID
      erc8004TokenId: TOKEN_A,
    });
    expect(v.linked).toBe(false);
    expect(v.onchain_agent_id).toBeNull();
    expect(v.failures).toContain('uri_carries_uuid');
  });

  it('always returns a non-empty unproven[] on a positive match (no silent overclaim)', () => {
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI: agentURIForAgentId(AGENT_A),
      erc8004TokenId: TOKEN_A,
    });
    expect(v.linked).toBe(true);
    expect(v.unproven.length).toBeGreaterThanOrEqual(3);
    expect(v.unproven.join(' ')).toMatch(/public input/i);
    expect(v.unproven.join(' ')).toMatch(/setAgentURI/i);
  });
});

describe('erc8004-linkage: linkageCommitment (the minimal binding to add to the proof)', () => {
  it('is deterministic and 0x+64 hex', () => {
    const c1 = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const c2 = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is case-insensitive on the address (checksummed == lowercase)', () => {
    const lower = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const upper = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A.toUpperCase().replace('0X', '0x'),
    });
    expect(lower).toBe(upper);
  });

  it('changes when ANY bound field changes (agent, token, or address)', () => {
    const base = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    expect(
      linkageCommitment({ agentId: AGENT_B, erc8004TokenId: TOKEN_A, erc8004Address: ADDR_A }),
    ).not.toBe(base);
    expect(
      linkageCommitment({ agentId: AGENT_A, erc8004TokenId: TOKEN_B, erc8004Address: ADDR_A }),
    ).not.toBe(base);
    expect(
      linkageCommitment({ agentId: AGENT_A, erc8004TokenId: TOKEN_A, erc8004Address: ADDR_B }),
    ).not.toBe(base);
  });

  it('is domain-separated (a different domain yields a different commitment)', () => {
    const a = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const b = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
      domain: 'hyperdag/health/consent-linkage/v1',
    });
    expect(a).not.toBe(b);
  });

  it('rejects malformed inputs (non-UUID agent, non-numeric token, bad address)', () => {
    expect(() =>
      linkageCommitment({ agentId: 'not-a-uuid', erc8004TokenId: TOKEN_A, erc8004Address: ADDR_A }),
    ).toThrow();
    expect(() =>
      linkageCommitment({ agentId: AGENT_A, erc8004TokenId: '0xabc', erc8004Address: ADDR_A }),
    ).toThrow();
    expect(() =>
      linkageCommitment({ agentId: AGENT_A, erc8004TokenId: TOKEN_A, erc8004Address: '0xshort' }),
    ).toThrow();
  });
});

describe('erc8004-linkage: full linkage incl. the commitment leg', () => {
  it('LINKS when both the URI UUID and the linkage commitment match', () => {
    // The proof would carry this commitment as a public input; the verifier
    // recomputes it from (UUID-from-tokenURI, tokenId, on-chain address).
    const boundCommitment = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI: agentURIForAgentId(AGENT_A),
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
      expectedLinkageCommitment: boundCommitment,
    });
    expect(v.linked).toBe(true);
    expect(v.checks.linkage_commitment_matches).toBe(true);
  });

  it('does NOT link when the commitment binds a different address (tamper detected)', () => {
    const boundToA = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI: agentURIForAgentId(AGENT_A),
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_B, // verifier reads a different address on-chain
      expectedLinkageCommitment: boundToA,
    });
    expect(v.linked).toBe(false);
    expect(v.failures).toContain('linkage_commitment_matches');
  });
});

describe('erc8004-linkage: Invariant 1 — Poseidon2/BabyBear only, no sha256/keccak', () => {
  it('this module imports no sha256/keccak hashing', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'zkp', 'erc8004-linkage.ts'),
      'utf8',
    );
    // Strip the prose header/comments so documentation mentions don't trip the grep.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/createHash|sha256|keccak|sha3/i);
    expect(code).toMatch(/poseidon2/i);
  });

  it('exposes a stable domain namespace key (Invariant 6)', () => {
    expect(ERC8004_LINKAGE_DOMAIN).toBe('hyperdag/erc8004/repid-linkage/v1');
    expect(DEFAULT_AGENT_METADATA_BASE).toBe('https://repid.dev/agents');
  });
});

describe('erc8004-linkage: token-in-statement — proof carries its own token id (server-free)', () => {
  const onChainAgentURI = agentURIForAgentId(AGENT_A); // what tokenURI(TOKEN_A) returns

  it('a token-bound statement links WITHOUT the caller naming the token from the server DB', () => {
    // The statement itself carries erc8004_token_id — the verifier reads WHICH token to
    // check straight from the proof, then reads tokenURI(that) on-chain.
    const statement = buildBoundStatement({
      agentId: AGENT_A,
      repidScore: 2280,
      threshold: 999,
      erc8004TokenId: TOKEN_A,
    });
    const v = verifyStatementLinksToToken(statement, { onChainAgentURI });
    expect(v.linked).toBe(true);
    expect(v.checks.statement_carries_token_id).toBe(true);
    expect(v.onchain_agent_id).toBe(AGENT_A);
  });

  it('shrinks unproven[]: a token-bound statement has strictly FEWER residual-trust items', () => {
    const withoutToken = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI,
      erc8004TokenId: TOKEN_A,
    });
    const withToken = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI,
      erc8004TokenId: TOKEN_A,
      statementTokenId: TOKEN_A,
    });
    expect(withToken.linked).toBe(true);
    expect(withoutToken.linked).toBe(true);
    // The core deliverable: carrying the token id removes a residual.
    expect(withToken.unproven.length).toBeLessThan(withoutToken.unproven.length);
    // The removed residual is the "which token? trust the server DB" one.
    expect(withoutToken.unproven.join(' ')).toMatch(/trusting the server DB/i);
    expect(withToken.unproven.join(' ')).not.toMatch(/trusting the server DB/i);
    // Never zero — the prover-side public-input step is still owed, honestly stated.
    expect(withToken.unproven.length).toBeGreaterThanOrEqual(1);
    expect(withToken.unproven.join(' ')).toMatch(/PUBLIC INPUT/);
  });

  it('detects a statement that names a DIFFERENT token than the one queried on-chain', () => {
    const v = verifyProofLinksToToken({
      statementAgentId: AGENT_A,
      onChainAgentURI,
      erc8004TokenId: TOKEN_A, // the token the verifier actually read on-chain
      statementTokenId: TOKEN_B, // but the proof statement points at a different token
    });
    expect(v.linked).toBe(false);
    expect(v.failures).toContain('statement_token_id_matches_queried');
  });

  it('a bare (agent-only) statement degrades to the full residual list — no fabricated binding', () => {
    const bare = buildBoundStatement({ agentId: AGENT_A, repidScore: 2280, threshold: 999 });
    const v = verifyStatementLinksToToken(bare, {
      onChainAgentURI,
      erc8004TokenId: TOKEN_A, // caller had to bring the token from the server
    });
    expect(v.linked).toBe(true);
    expect(v.checks.statement_carries_token_id).toBeUndefined();
    expect(v.unproven.join(' ')).toMatch(/trusting the server DB/i);
  });

  it('the token binding composes with the commitment leg (both checked, both must match)', () => {
    const boundCommitment = linkageCommitment({
      agentId: AGENT_A,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const statement = buildBoundStatement({
      agentId: AGENT_A,
      repidScore: 2280,
      threshold: 999,
      erc8004TokenId: TOKEN_A,
      erc8004Address: ADDR_A,
    });
    const v = verifyStatementLinksToToken(statement, {
      onChainAgentURI,
      erc8004Address: ADDR_A,
      expectedLinkageCommitment: boundCommitment,
    });
    expect(v.linked).toBe(true);
    expect(v.checks.statement_carries_token_id).toBe(true);
    expect(v.checks.linkage_commitment_matches).toBe(true);
  });
});
