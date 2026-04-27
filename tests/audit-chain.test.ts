/**
 * Audit chain public reads — sanitization tests.
 *
 * No external network. Focus is on the sanitisePayload helper because
 * its allowlist is the load-bearing piece for the public-reads contract.
 * The query-shaped functions (getRecent, getEvent, etc.) wrap a
 * Supabase call and are integration-testable only against a real DB —
 * deferred to staging.
 */

import { _internals } from '../src/services/audit-chain-public';

const sanitise = _internals.sanitisePayload;

describe('audit-chain-public — sanitisePayload', () => {
  it('whitelists sbt_mint fields and drops unknown ones', () => {
    const input = {
      event_type: 'sbt_mint',
      holder: '0xabc',
      token_id: '12345',
      tx_hash: '0xtx',
      metadata_inline: true,
      is_mock: true,
      // Fields that MUST NOT pass the sanitiser:
      _internal_query: 'SELECT * FROM ...',
      private_email: 'sean@example.com',
      raw_db_row: { secret_field: 'leak' },
    };
    const out = sanitise(input);
    expect(out.event_type).toBe('sbt_mint');
    expect(out.payload.holder).toBe('0xabc');
    expect(out.payload.token_id).toBe('12345');
    expect(out.payload.metadata_inline).toBe(true);
    expect(out.payload._internal_query).toBeUndefined();
    expect(out.payload.private_email).toBeUndefined();
    expect(out.payload.raw_db_row).toBeUndefined();
  });

  it('drops the raw holder field on threshold-proof events to preserve ZK intent', () => {
    const input = {
      event_type: 'repid_threshold_proof_generated',
      outcome: 'ok',
      threshold: 5000,
      holder: '0xabc',                  // MUST be dropped
      holder_commitment: '0xcommit',     // OK to surface
      plonky3_version: 'babybear-stub-v1',
      is_mock: true,
    };
    const out = sanitise(input);
    expect(out.payload.holder_commitment).toBe('0xcommit');
    expect(out.payload.holder).toBeUndefined();
  });

  it('fails closed for unknown event_type — surfaces only event_type + opaque marker', () => {
    const input = {
      event_type: 'never_seen_before',
      sensitive_field: 'leak',
      another: 42,
    };
    const out = sanitise(input);
    expect(out.payload._sanitised).toBe(true);
    expect(out.payload.sensitive_field).toBeUndefined();
    expect(out.payload.another).toBeUndefined();
    expect(out.event_type).toBe('never_seen_before');
  });

  it('handles missing event_type gracefully', () => {
    const out = sanitise({ random_field: 'x' });
    expect(out.event_type).toBeNull();
    expect(out.payload._sanitised).toBe(true);
    expect(out.payload.random_field).toBeUndefined();
  });

  it('passes through agent_registration fields per fleet sprint', () => {
    const input = {
      event_type: 'agent_registration',
      agent_name: 'SOPHIA',
      token_id: '3747',
      mint_tx: '0xtx',
      metadata_inline: true,
      // Fields the allowlist drops:
      private_owner_pii: 'leak',
    };
    const out = sanitise(input);
    expect(out.payload.agent_name).toBe('SOPHIA');
    expect(out.payload.token_id).toBe('3747');
    expect(out.payload.metadata_inline).toBe(true);
    expect(out.payload.private_owner_pii).toBeUndefined();
  });
});
