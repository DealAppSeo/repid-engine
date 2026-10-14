/**
 * capability-registry.ts — Mission 1 #5, the REAL poisoned-repo control (Draft 1: the pure core).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE THREAT, AND WHY #1347's DECLARED-NAME SCREEN DID NOT CLOSE IT
 * ════════════════════════════════════════════════════════════════════════════════
 * A poisoned repo (untrusted content the agent ingested) steers a tool call toward exfiltrating a
 * secret or poisoning trusted memory. #1347 screened the CALLER-ASSERTED tool NAME against a regex.
 * XC1 proved that is bypassable three ways: a tool named `formatter` (class `read`) whose CLOSURE
 * exfiltrates is ALLOWed and run (the kernel never sees the closure, only name + args hash); the
 * pattern set is evadable (`get_secret`, `read_private_key`, `write_trusted_memory`, zero-width /
 * NBSP, …); and a non-match fails OPEN.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE TRUST BOUNDARY, AFTER THIS FIX (the claim to attack)
 * ════════════════════════════════════════════════════════════════════════════════
 * Capability is KERNEL-OWNED, bound to a function the kernel loaded AT BOOT, by REFERENCE. It is NOT
 * derived from `tool.class`/`tool.name`, NOT from any request-supplied capability or hash, and NOT
 * from a forgeable `fn.toString()`. A tool runs only if it resolves to a REGISTERED implementation,
 * that registered identity is AUTHORIZED by the signed owner policy, and its (kernel-owned)
 * capability is not prohibited. Under enforcement the kernel runs the REGISTERED implementation —
 * never a caller-supplied closure (that wiring is Draft 3; this module is the pure decision + the
 * reference-equality primitive it rests on).
 *
 * This honours XC1's conditions 1/2/3:
 *  (1) Caller-asserted data must NOT pick the capability. `CapabilityQuery` carries only a reference
 *      (which registered id the request names) and, optionally, the function that WOULD run — never a
 *      capability or a hash. The capability is read ONLY from the registry entry.
 *  (2) Hash-of-the-wrapper ≠ hash-of-the-effect. Identity is REFERENCE EQUALITY to a boot-registered
 *      function (`isRegisteredImplementation`), never a content hash of a closure. A look-alike closure
 *      with identical source is NOT the registered object and does not run. And the registry is NOT
 *      writable from the request path — `register()` lives on the concrete class and is called ONLY at
 *      boot by trusted module code; the decision path is handed a `ReadonlyCapabilityRegistry` with no
 *      mutator, so a poisoned repo has no code path to insert a row.
 *  (3) Unregistered must NOT fall through to benign, and the blanket `tool` action authorizes NOTHING.
 *      `screenCapability` FAILS CLOSED on anything it cannot positively establish, and an EMPTY
 *      authorized set authorizes no implementation.
 *
 * HONEST SCOPE: the kernel governs only what runs THROUGH it (Draft 3's runUnderKernel). Code executed
 * without going through the kernel is outside its mediation and out of scope. This closes the in-kernel
 * execution path, not the universe.
 *
 * PURE: no I/O, no env, no secrets. Draft 2 maps this module's result onto the kernel Reason/Check and
 * wires it into decide(); Draft 3 supplies the real `candidate` and runs the registered implementation.
 */

// ── prohibited capabilities (a FLOOR under the registry, not the load-bearing control) ───────────────
//
// The registry identity (above) is what actually stops the formatter bypass. This prohibition list is
// defence-in-depth: even a registered, authorized implementation whose KERNEL-OWNED capability is a
// secret-export or trusted-memory-write is refused, regardless of policy, trust or stake. The patterns
// are ported from #1347's prohibited.ts AND EXTENDED to the verb-then-noun shapes and the unicode
// evasions XC1 listed (#1347's set missed `get_secret`, `read_private_key`, `write_trusted_memory`, and
// did not normalize zero-width / NBSP). Matching is a floor: additions only ever refuse more.

export type ProhibitedCapability = 'secret_export' | 'trusted_memory_write';

/**
 * Normalize before matching so zero-width joiners, soft hyphens and NBSP cannot smuggle a prohibited
 * capability past the patterns. NFKC folds width/compatibility variants (incl. NBSP → space); we then
 * strip zero-width characters and collapse any whitespace to a single `_` (a recognized separator), and
 * lowercase. This is for MATCHING only — it is never shown and never stored.
 */
function normalizeForScreen(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // Case is still intact here so camelCase can be split. `exportAllSecrets` becomes
  // `export_all_secrets` before the separator patterns run. Matching only — never stored.
  const folded = s.normalize('NFKC').replace(/[​-‍﻿­]/g, ''); // zero-width space/joiner/BOM, soft hyphen
  const split = folded.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return split.replace(/\s+/g, '_').toLowerCase(); // NBSP folds to space under NFKC
}

/** Separators removed, so `exportallsecrets` and `secrets_export` share one compact form. */
function squeezeForScreen(normalized: string): string {
  return normalized.replace(/[._/:-]/g, '');
}

const SEP = '[._/:-]';
const SECRET_NOUN =
  '(?:secret|secrets|credential|credentials|api[._/:-]?key|api[._/:-]?keys|private[._/:-]?key|priv[._/:-]?key|privatekey|env|dotenv|keyring|keystore|token|mnemonic|seed[._/:-]?phrase)s?';
const MEM_WRITE_VERB = '(?:write|set|put|store|append|upsert|update|save|insert|commit)';
const TRUSTED_MEM = '(?:trusted|canonical|root|verified)';

// verb-then-secret: export/leak/send … the secret (from #1347). No trailing \b — the prohibition is a
// FLOOR, so a verb immediately followed by more (`export_all`, `api_keys_now`) must still match; a strict
// word boundary there is exactly how `secrets.export_all` slipped. Over-matching only ever refuses more.
const SECRET_VERB =
  '(?:export|exfiltrate|exfil|reveal|dump|leak|disclose|send|post|upload|share|print|get|read|fetch|retrieve|load|copy|cat|show|list)';
const SECRET_EXPORT = new RegExp(
  `(?:^|${SEP})(?:export|exfiltrate|exfil|reveal|dump|leak|disclose|send|post|upload|share|print)${SEP}?(?:the${SEP}?)?${SECRET_NOUN}`,
  'i',
);
// Verb, then one or more tokens, then the noun: `export_all_secrets` after camelCase splitting.
const SECRET_EXPORT_INFIX = new RegExp(`(?:^|${SEP})${SECRET_VERB}(?:${SEP}[a-z0-9]+)+${SEP}?${SECRET_NOUN}`, 'i');
// verb-then-secret for READ-ish verbs: get_secret, read_private_key, fetch_token (NEW — XC1's list).
const SECRET_READ = new RegExp(
  `(?:^|${SEP})(?:get|read|fetch|retrieve|load|copy|cat|show|list)${SEP}?(?:the${SEP}?)?${SECRET_NOUN}`,
  'i',
);
// secret-namespace-then-verb: secrets.export_all, credential.read (from #1347).
const SECRET_NAMESPACE = new RegExp(
  `(?:^|${SEP})(?:secret|secrets|credential|credentials|keyring|keystore|vault|env|dotenv)${SEP}(?:export|read|get|reveal|dump|list|all|send|post|fetch|copy|upload|exfiltrate|leak|disclose|share|print)`,
  'i',
);
// trusted-memory-then-write: trusted_memory.write (from #1347).
const TRUSTED_MEMORY_WRITE = new RegExp(
  `(?:^|${SEP})(?:trusted${SEP}?memory|memory${SEP}?trusted|canonical${SEP}?memory|root${SEP}?memory)${SEP}?${MEM_WRITE_VERB}`,
  'i',
);
// memory.write.trusted: memory-write-then-trusted tier (from #1347).
const MEMORY_WRITE_TRUSTED = new RegExp(
  `(?:^|${SEP})(?:memory|mem)${SEP}${MEM_WRITE_VERB}${SEP}?${TRUSTED_MEM}`,
  'i',
);
// verb-then-trusted-memory: write_trusted_memory, set_root_state (NEW — XC1's list).
const WRITE_TRUSTED_MEMORY = new RegExp(
  `(?:^|${SEP})${MEM_WRITE_VERB}${SEP}?${TRUSTED_MEM}${SEP}?(?:memory|mem|store|state)`,
  'i',
);

/**
 * Separator-free form. CamelCase splitting does nothing to `exportallsecrets`. The noun and the verb
 * have to be present as whole stems, in either order. Short stems (`env`, `token`) stay on the
 * separator patterns above so they do not fire inside a longer benign word.
 */
function compactSecretExport(squeezed: string): boolean {
  const verb =
    '(?:export|exfiltrate|exfil|reveal|dump|leak|disclose|upload|share|print|get|read|fetch|retrieve|load|copy|cat|show|list|send)';
  const noun = '(?:secrets|secret|credentials|credential|privatekey|privkey|apikey|apikeys|keyring|keystore|mnemonic|seedphrase|dotenv)';
  const namespace = '(?:secrets|secret|credentials|credential|keyring|keystore|vault|dotenv)';
  const namespaceVerb =
    '(?:export|exfiltrate|exfil|reveal|dump|leak|disclose|upload|share|print|get|read|fetch|retrieve|load|copy|show|list|all|send)';
  return new RegExp(`${verb}(?:all|the)?${noun}`, 'i').test(squeezed) || new RegExp(`${namespace}${namespaceVerb}`, 'i').test(squeezed);
}

/**
 * Classify a KERNEL-OWNED capability id as a hard-prohibited capability, or null. PURE. Applied to the
 * registry entry's capability — never to a caller-asserted tool name (that is the lie #1347 fell for).
 */
export function classifyProhibitedCapability(capabilityId: unknown): ProhibitedCapability | null {
  const n = normalizeForScreen(capabilityId);
  if (n === '') return null;
  if (
    SECRET_EXPORT.test(n) ||
    SECRET_READ.test(n) ||
    SECRET_NAMESPACE.test(n) ||
    SECRET_EXPORT_INFIX.test(n) ||
    compactSecretExport(squeezeForScreen(n))
  ) {
    return 'secret_export';
  }
  if (TRUSTED_MEMORY_WRITE.test(n) || MEMORY_WRITE_TRUSTED.test(n) || WRITE_TRUSTED_MEMORY.test(n)) {
    return 'trusted_memory_write';
  }
  return null;
}

/** Boot and per-decision signal that the flag is on and the registry has nothing in it. */
export function logCapabilityRegistryEmpty(site: 'boot' | 'decision'): void {
  console.error(
    `[kernel] LOUD capability registry is empty at ${site}. KERNEL_CAPABILITY_REGISTRY_ENABLED is on and no implementation is registered; decisions DENY with registry_empty.`,
  );
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────

/** Kernel-owned capability metadata, set at REGISTRATION, never from a request. */
export interface Capability {
  /** Kernel-owned capability id, e.g. `format.markdown`. The prohibition floor screens THIS, not a name. */
  id: string;
  /** Optional human label for the audit trail. */
  label?: string;
}

export type ToolImplementation = (...args: never[]) => unknown;

/** A registered implementation: the actual boot-loaded function plus its kernel-minted identity. */
export interface RegisteredImplementation {
  /**
   * Kernel-minted identity the owner policy authorizes. It is an IDENTITY TOKEN for a registered
   * implementation, NOT a content hash of the closure (XC1 #2). The anti-forgery property comes from
   * reference equality to `run`, not from this string's value.
   */
  implId: string;
  capability: Capability;
  /** The actual function object loaded at boot from trusted kernel/module code. Identity is by REFERENCE. */
  run: ToolImplementation;
}

/** The read-only view handed to the request/decision path. No mutator ⇒ the request path cannot register. */
export interface ReadonlyCapabilityRegistry {
  resolveById(implId: string): RegisteredImplementation | null;
  /** Reference-equality membership: is this the exact function object the kernel registered at boot? */
  isRegisteredImplementation(fn: unknown): boolean;
  readonly size: number;
}

/**
 * The writable registry. `register()` is the ONLY mutator and is called ONLY at boot by trusted module
 * code — never from a request handler, never from repo-ingested content. The decision path receives the
 * `ReadonlyCapabilityRegistry` view, so a poisoned repo has no code path to insert or swap a row.
 */
export class CapabilityRegistry implements ReadonlyCapabilityRegistry {
  private readonly byId = new Map<string, RegisteredImplementation>();
  private readonly fns = new Set<ToolImplementation>();

  /**
   * Register a boot implementation. Fails loud on a malformed entry or a DUPLICATE implId (so a later
   * registration can never swap the function bound to an already-authorized identity). A given function
   * object may back at most one implId.
   */
  register(entry: RegisteredImplementation): void {
    const implId = typeof entry?.implId === 'string' ? entry.implId.trim() : '';
    if (implId === '') throw new Error('[capability-registry] implId must be a non-empty string');
    if (!entry.capability || typeof entry.capability.id !== 'string' || entry.capability.id.trim() === '') {
      throw new Error('[capability-registry] a registered implementation must carry a non-empty capability.id');
    }
    if (typeof entry.run !== 'function') {
      throw new Error('[capability-registry] run must be a function (the boot-loaded implementation)');
    }
    if (this.byId.has(implId)) {
      throw new Error(`[capability-registry] implId '${implId}' is already registered; registration is boot-only and never overwrites`);
    }
    if (this.fns.has(entry.run)) {
      throw new Error('[capability-registry] this function is already registered under another implId');
    }
    this.byId.set(implId, { implId, capability: { ...entry.capability }, run: entry.run });
    this.fns.add(entry.run);
  }

  resolveById(implId: string): RegisteredImplementation | null {
    if (typeof implId !== 'string') return null;
    return this.byId.get(implId.trim()) ?? null;
  }

  isRegisteredImplementation(fn: unknown): boolean {
    return typeof fn === 'function' && this.fns.has(fn as ToolImplementation);
  }

  get size(): number {
    return this.byId.size;
  }
}

/** Construct an empty writable registry (boot code populates it). */
export function createCapabilityRegistry(): CapabilityRegistry {
  return new CapabilityRegistry();
}

// ── the screen (pure decision; fail-closed) ──────────────────────────────────────────────────────────

/**
 * What the kernel builds from a request. It carries ONLY a reference and, optionally, the function that
 * would run — never a capability or a hash the caller asserts (XC1 #1).
 */
export interface CapabilityQuery {
  /** Which registered implementation the request names (a kernel-minted implId). A reference, not a claim. */
  implRef: string | null | undefined;
  /**
   * The function the gate would actually run, when known (Draft 3 supplies it). When present it MUST be
   * reference-equal to the resolved registry entry's `run`, or the screen fails closed — this is what makes
   * a caller-chosen reference safe (a mismatch is denied BEFORE the call).
   */
  candidate?: unknown;
}

export type CapabilityOutcome = 'PASS' | 'FAIL';

export type CapabilityReasonCode =
  | 'unregistered_tool'
  | 'impl_reference_mismatch'
  | 'impl_unauthorized'
  | 'prohibited_capability'
  | 'registry_empty';

export interface CapabilityScreen {
  outcome: CapabilityOutcome;
  /** True only when registered AND authorized AND not prohibited AND (if given) the candidate matches. */
  allow: boolean;
  /** The resolved KERNEL-OWNED capability id, or null. Never derived from the caller's reference string. */
  capabilityId: string | null;
  implId: string | null;
  /** The registered function to run (Draft 3 runs THIS, never the caller closure). Null unless PASS. */
  run: ToolImplementation | null;
  /** Free-string reason code for the audit trail (Draft 2 maps it onto the kernel Reason). */
  code: CapabilityReasonCode | null;
  /** Short and safe: never a secret, never raw arguments. */
  detail: string;
}

function fail(code: CapabilityReasonCode, detail: string): CapabilityScreen {
  return { outcome: 'FAIL', allow: false, capabilityId: null, implId: null, run: null, code, detail };
}

/**
 * Resolve whether a tool call is permitted by the capability model. FAILS CLOSED on anything it cannot
 * positively establish, and never throws. The capability is read ONLY from the registry entry.
 */
export function screenCapability(
  query: CapabilityQuery,
  registry: ReadonlyCapabilityRegistry,
  authorizedImplIds: ReadonlySet<string>,
): CapabilityScreen {
  // An empty boot registry is not "this one tool is unregistered". Every name would fail that way,
  // including the deliberate exceptions, and the operator would not see why.
  if (registry.size === 0) {
    return fail('registry_empty', 'the capability registry is empty; enforcement is on and nothing is registered');
  }
  const ref = typeof query?.implRef === 'string' ? query.implRef.trim() : '';
  if (ref === '') {
    return fail('unregistered_tool', 'no registered implementation was referenced; fail closed');
  }

  const entry = registry.resolveById(ref);
  if (!entry) {
    return fail('unregistered_tool', 'the referenced implementation is not registered; fail closed');
  }

  // (2) Reference equality: if the gate told us the function it would run, it MUST be the registered
  // object — a look-alike closure (same source, different object) is a mismatch and is refused BEFORE
  // the call. A non-function candidate also fails closed.
  if (query.candidate !== undefined) {
    if (
      typeof query.candidate !== 'function' ||
      query.candidate !== entry.run ||
      !registry.isRegisteredImplementation(query.candidate)
    ) {
      return fail('impl_reference_mismatch', 'the function that would run is not the registered implementation; fail closed');
    }
  }

  // (3) Authorization: the owner policy must authorize this exact registered identity. An empty set
  // authorizes nothing (the blanket `tool` action grants no implementation).
  if (!authorizedImplIds.has(entry.implId)) {
    return fail('impl_unauthorized', 'the owner policy does not authorize this registered implementation; fail closed');
  }

  // Prohibition floor on the KERNEL-OWNED capability (defence-in-depth; the registry above is the control).
  const prohibited = classifyProhibitedCapability(entry.capability.id);
  if (prohibited) {
    return fail('prohibited_capability', `the registered capability is hard-prohibited (${prohibited}); refused regardless of policy, trust or stake`);
  }

  return {
    outcome: 'PASS',
    allow: true,
    capabilityId: entry.capability.id,
    implId: entry.implId,
    run: entry.run,
    code: null,
    detail: 'registered, authorized, and not prohibited',
  };
}
