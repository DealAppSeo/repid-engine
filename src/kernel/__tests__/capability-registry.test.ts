/**
 * capability-registry.test.ts — Draft 1 proves the pure core closes the poisoned-repo threat at the
 * decision level, honouring XC1's conditions 1/2/3. Draft 2 wires it into decide(); Draft 3 supplies the
 * real candidate and runs the registered implementation.
 */
import {
  CapabilityRegistry,
  createCapabilityRegistry,
  classifyProhibitedCapability,
  screenCapability,
  type ReadonlyCapabilityRegistry,
  type RegisteredImplementation,
} from '../capability-registry';

// Distinct boot-loaded function objects. Identity is by REFERENCE, so look-alikes with identical source
// are deliberately separate objects in these fixtures.
const benignRun = (): string => 'formatted';
const secretRun = (): string => 'leaked'; // a registered impl whose CAPABILITY is a secret export
const rotateRun = (): string => 'rotated';
const readTrustedRun = (): string => 'read';

function fixture(): { reg: CapabilityRegistry; authorized: Set<string> } {
  const reg = createCapabilityRegistry();
  reg.register({ implId: 'impl.formatter', capability: { id: 'format.markdown' }, run: benignRun });
  reg.register({ implId: 'impl.secret', capability: { id: 'secrets.export_all' }, run: secretRun });
  reg.register({ implId: 'impl.rotate', capability: { id: 'secrets.rotate' }, run: rotateRun });
  reg.register({ implId: 'impl.readtrusted', capability: { id: 'memory.read_trusted' }, run: readTrustedRun });
  // The owner policy authorizes these registered identities (Draft 2 sources this from the signed policy).
  const authorized = new Set(['impl.formatter', 'impl.secret', 'impl.rotate', 'impl.readtrusted']);
  return { reg, authorized };
}

// ════════════════════════════════════════════════════════════════════════════════════════
describe('XC1 #2 — identity is REFERENCE EQUALITY to a boot-registered function, not a forgeable hash', () => {
  it('recognises the exact registered object and rejects a source-identical look-alike', () => {
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.x', capability: { id: 'format.markdown' }, run: benignRun });
    expect(reg.isRegisteredImplementation(benignRun)).toBe(true);
    // Same SOURCE, different OBJECT — the fn.toString() attack. Not registered.
    const lookAlike = (): string => 'formatted';
    expect(lookAlike.toString()).toBe(benignRun.toString()); // identical source
    expect(reg.isRegisteredImplementation(lookAlike)).toBe(false);
    // A stable-dispatcher look-alike is also unregistered.
    const dispatcher = (): string => 'formatted';
    expect(reg.isRegisteredImplementation(dispatcher)).toBe(false);
    expect(reg.isRegisteredImplementation('formatter')).toBe(false);
    expect(reg.isRegisteredImplementation(undefined)).toBe(false);
  });

  it('registration is boot-only and never overwrites: duplicate implId, re-used fn, and malformed entries throw', () => {
    const reg = createCapabilityRegistry();
    reg.register({ implId: 'impl.x', capability: { id: 'format.markdown' }, run: benignRun });
    // A second registration cannot swap the function under an already-authorized identity.
    expect(() => reg.register({ implId: 'impl.x', capability: { id: 'format.markdown' }, run: secretRun })).toThrow(/already registered/);
    // The same function cannot be re-registered under a new identity.
    expect(() => reg.register({ implId: 'impl.y', capability: { id: 'format.html' }, run: benignRun })).toThrow(/already registered under another/);
    expect(() => reg.register({ implId: '', capability: { id: 'format.markdown' }, run: rotateRun })).toThrow(/implId/);
    expect(() => reg.register({ implId: 'impl.z', capability: { id: '' }, run: rotateRun })).toThrow(/capability\.id/);
    expect(() => reg.register({ implId: 'impl.w', capability: { id: 'x' }, run: 'not-a-fn' as unknown as RegisteredImplementation['run'] })).toThrow(/must be a function/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('XC1 #1 — the caller cannot pick the capability; it is read KERNEL-SIDE from the registry', () => {
  it('a request-injected capability/hash is ignored; the capability comes from the registry entry', () => {
    const { reg, authorized } = fixture();
    // A caller smuggles a capability + hash onto the query. The screen must ignore them.
    const smuggled = { implRef: 'impl.formatter', capability: 'secrets.export_all', implementation_hash: 'deadbeef' } as unknown as {
      implRef: string;
    };
    const r = screenCapability(smuggled, reg, authorized);
    expect(r.allow).toBe(true);
    expect(r.capabilityId).toBe('format.markdown'); // the ENTRY's capability, not the smuggled one
    expect(r.run).toBe(benignRun);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('XC1 #3 — unregistered fails CLOSED and the blanket authorization grants nothing', () => {
  it('THE FORMATTER BYPASS: an unregistered reference is DENIED, not run', () => {
    const { reg, authorized } = fixture();
    const r = screenCapability({ implRef: 'formatter' }, reg, authorized); // caller-asserted name, not a registered implId
    expect(r.allow).toBe(false);
    expect(r.outcome).toBe('FAIL');
    expect(r.code).toBe('unregistered_tool');
    expect(r.run).toBeNull();
  });

  it('the swapped-closure-behind-an-authorized-name is DENIED before the call (candidate mismatch)', () => {
    const { reg, authorized } = fixture();
    const malicious = (): string => 'exfiltrate'; // a repo closure the caller tries to run under a registered id
    const r = screenCapability({ implRef: 'impl.formatter', candidate: malicious }, reg, authorized);
    expect(r.allow).toBe(false);
    expect(r.code).toBe('impl_reference_mismatch');
    expect(r.run).toBeNull();
  });

  it('a registered implementation not authorized by the policy is DENIED (empty set authorizes nothing)', () => {
    const { reg } = fixture();
    expect(screenCapability({ implRef: 'impl.formatter' }, reg, new Set()).code).toBe('impl_unauthorized');
    expect(screenCapability({ implRef: 'impl.formatter' }, reg, new Set(['impl.other'])).code).toBe('impl_unauthorized');
  });

  it('an empty / null / undefined reference fails closed, and the screen never throws', () => {
    const { reg, authorized } = fixture();
    for (const implRef of ['', '   ', null, undefined]) {
      const r = screenCapability({ implRef }, reg, authorized);
      expect(r.allow).toBe(false);
      expect(r.code).toBe('unregistered_tool');
    }
    // garbage input does not throw
    expect(() => screenCapability({ implRef: 123 as unknown as string }, reg, authorized)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('a registered, authorized, benign tool ALLOWs — and the registered impl is what runs', () => {
  it('PASSes and returns the registered function (Draft 3 runs THIS, never the caller closure)', () => {
    const { reg, authorized } = fixture();
    const r = screenCapability({ implRef: 'impl.formatter', candidate: benignRun }, reg, authorized);
    expect(r.allow).toBe(true);
    expect(r.outcome).toBe('PASS');
    expect(r.capabilityId).toBe('format.markdown');
    expect(r.implId).toBe('impl.formatter');
    expect(r.run).toBe(benignRun);
    expect(r.code).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('prohibition FLOOR — a registered+authorized secret-export / trusted-memory-write is still refused', () => {
  it('a registered secret-export capability is DENIED even when authorized', () => {
    const { reg, authorized } = fixture();
    const r = screenCapability({ implRef: 'impl.secret', candidate: secretRun }, reg, authorized);
    expect(r.allow).toBe(false);
    expect(r.code).toBe('prohibited_capability');
    expect(r.run).toBeNull();
  });

  it('the DELIBERATE EXCEPTIONS still ALLOW: memory.read_trusted and secrets.rotate are not prohibited', () => {
    const { reg, authorized } = fixture();
    expect(screenCapability({ implRef: 'impl.rotate', candidate: rotateRun }, reg, authorized).allow).toBe(true);
    expect(screenCapability({ implRef: 'impl.readtrusted', candidate: readTrustedRun }, reg, authorized).allow).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe("classifyProhibitedCapability — XC1's evasion list no longer slips (verb-then-noun + unicode)", () => {
  it('classifies the secret-export shapes #1347 missed', () => {
    for (const id of [
      'secrets.export_all',
      'export_api_key',
      'get_secret',
      'read_private_key',
      'send_credentials',
      'dump_keystore',
      'reveal_mnemonic',
      'credential.read',
    ]) {
      expect(classifyProhibitedCapability(id)).toBe('secret_export');
    }
  });

  it('classifies the trusted-memory-write shapes #1347 missed', () => {
    for (const id of ['write_trusted_memory', 'trusted_memory.write', 'memory.write.trusted', 'set_root_memory']) {
      expect(classifyProhibitedCapability(id)).toBe('trusted_memory_write');
    }
  });

  it('sees through zero-width and NBSP evasions', () => {
    expect(classifyProhibitedCapability('get secret')).toBe('secret_export'); // NBSP
    expect(classifyProhibitedCapability('read private key')).toBe('secret_export');
    expect(classifyProhibitedCapability('write​trusted​memory')).toBe('trusted_memory_write'); // zero-width
    expect(classifyProhibitedCapability('export﻿api_key')).toBe('secret_export'); // BOM
  });

  it('does not over-classify benign capabilities or the deliberate exceptions', () => {
    for (const id of ['format.markdown', 'repid.read', 'http.get', 'memory.read_trusted', 'secrets.rotate', '']) {
      expect(classifyProhibitedCapability(id)).toBeNull();
    }
    expect(classifyProhibitedCapability(undefined)).toBeNull();
    expect(classifyProhibitedCapability(42)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the decision path receives a READ-ONLY registry view (no mutator on the request path)', () => {
  it('screenCapability is satisfied by the ReadonlyCapabilityRegistry surface alone', () => {
    const { reg, authorized } = fixture();
    // Narrow to the read-only view — the type the decision path (Draft 2) will actually hold.
    const ro: ReadonlyCapabilityRegistry = reg;
    expect('register' in (ro as object)).toBe(true); // the concrete instance still has it at runtime…
    // …but the decision path only ever TYPES it as ReadonlyCapabilityRegistry, which exposes no register.
    const r = screenCapability({ implRef: 'impl.formatter', candidate: benignRun }, ro, authorized);
    expect(r.allow).toBe(true);
    expect(ro.size).toBe(4);
  });
});
