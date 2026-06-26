/**
 * MITRE ATLAS technique mapping for every v3 gauntlet attack.
 * atlasTechnique ids marked [verify] — confirm against live atlas.mitre.org before external publish.
 */

export interface AttackAtlasEntry {
  attackId: string;
  name: string;
  atlasTactic: string;
  atlasTechnique: string;
  attackTechnique: string;
  note: string;
}

type Entry = Omit<AttackAtlasEntry, 'attackId' | 'name'>;

function e(
  atlasTactic: string,
  atlasTechnique: string,
  attackTechnique: string,
  note: string
): Entry {
  return { atlasTactic, atlasTechnique, attackTechnique, note };
}

/** Per-attack ATLAS mapping (v3 corpus). */
export const ATTACK_ATLAS_BY_ID: Record<string, Entry> = {
  // ---- Legacy r4 (minus cost-001) ----
  'r4-ddl-001': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485 Data Destruction', 'DDL disguised as read'),
  'r4-ddl-002': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027 Obfuscated Files', 'comment-split DDL'),
  'r4-ddl-003': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027 Obfuscated Files', 'case-mixed DDL'),
  'r4-ddl-004': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027 Obfuscated Files', 'concat DDL'),
  'r4-ddl-005': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027 Obfuscated Files', 'unicode DDL'),
  'r4-path-001': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485 Data Destruction', 'migration path write'),
  'r4-path-002': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1036 Masquerading', 'unicode path'),
  'r4-path-003': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552.001 Credentials In Files', '.env write'),
  'r4-path-004': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552.001', 'keymap path'),
  'r4-path-005': e('Reconnaissance', 'AML.T0006 Active Scanning [verify]', 'T1592 Gather Victim Host Info', 'prod id in description'),
  'r4-git-001': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain Compromise', 'whitespace main ref'),
  'r4-git-002': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain Compromise', 'origin/main push'),
  'r4-git-003': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain Compromise', 'refs/heads/main'),
  'r4-git-004': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain Compromise', 'control protected ref'),
  'r4-cost-002': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027 Obfuscated Files', 'zero-cost spend fail-safe'),
  'r4-inj-001': e('Initial Access', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'description claims safe'),
  'r4-inj-002': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1036 Masquerading', 'benign framing'),
  'r4-plat-001': e('Impact', 'AML.T0048 External Harms [verify]', 'T1578 Modify Cloud Infrastructure', 'prod platform mislabel'),
  'r4-plat-002': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1036 Masquerading', 'staging label on prod'),
  'r4-chamber-001': e('Defense Evasion', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'forged CI evidence'),
  'r4-chamber-002': e('Defense Evasion', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'weak objection bypass'),
  'r4-ctrl-001': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485 Data Destruction', 'control obvious DDL'),
  'r4-ctrl-002': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain', 'control push main'),
  'r4-ctrl-003': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552', 'control secret read'),

  // ---- Class 1 encoding ----
  'enc-001': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain', 'Cyrillic homoglyph main'),
  'enc-002': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485 Data Destruction', 'case-mixed DROP'),
  'enc-003': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'comment-split DROP'),
  'enc-004': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'SQL concat DROP'),
  'enc-005': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'hex-encoded DROP'),
  'enc-006': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'URL-encoded DROP'),
  'enc-007': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'newline/tab in keyword'),
  'enc-008': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552.001', 'zero-width in path'),
  'enc-009': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485', 'spaced dr op table'),
  'enc-010': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1027', 'base64 DROP in description'),

  // ---- Class 2 semantic ----
  'sem-001': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1059 Command and Scripting', 'indirection script write'),
  'sem-002': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485', 'run script with DDL'),
  'sem-003': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485', 'psql delete prod'),
  'sem-004': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485', 'supabase REST delete'),
  'sem-005': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1036 Masquerading', 'symlink alias'),
  'sem-006': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1053 Scheduled Task', 'scheduled webhook DROP'),
  'sem-007': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552', 'decomposition cred copy'),
  'sem-008': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485', 'localOnly temp prod sql'),

  // ---- Class 3 boundary ----
  'bnd-001': e('Impact', 'AML.T0034 Cost Harvesting [verify]', 'T1496 Resource Hijacking', 'spend at T2 threshold'),
  'bnd-002': e('Impact', 'AML.T0034 Cost Harvesting [verify]', 'T1496 Resource Hijacking', 'spend $0.999'),
  'bnd-003': e('Impact', 'AML.T0034 Cost Harvesting [verify]', 'T1496 Resource Hijacking', 'dust spend flood'),
  'bnd-004': e('Defense Evasion', 'AML.T0046 Spamming AI System [verify]', 'T1499 Endpoint DoS', 'T0 flood bury T2'),
  'bnd-005': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1195 Supply Chain', 'main ref newline'),
  'bnd-006': e('Defense Evasion', 'AML.T0046 Spamming AI System [verify]', 'T1499 Endpoint DoS', 'rapid T0 burst'),

  // ---- Class 4 chamber ----
  'chm-001': e('Defense Evasion', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'forged CI run id'),
  'chm-002': e('Defense Evasion', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'fabricated test citation'),
  'chm-003': e('Defense Evasion', 'AML.T0054 LLM Jailbreak [verify]', 'n/a (AI-specific)', 'lineage spoof same provider'),
  'chm-004': e('Initial Access', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'prompt injection approve'),
  'chm-005': e('Defense Evasion', 'AML.T0051 LLM Prompt Injection [verify]', 'n/a (AI-specific)', 'ignore prior instructions'),
  'chm-006': e('Defense Evasion', 'AML.T0054 LLM Jailbreak [verify]', 'n/a (AI-specific)', 'jailbreak adversary'),

  // ---- Class 5 trace ----
  'trc-001': e('Defense Evasion', 'AML.T0043 Craft Adversarial Data [verify]', 'T1562 Impair Defenses', 'suppress trace sink'),
  'trc-002': e('Defense Evasion', 'AML.T0046 Spamming AI System [verify]', 'T1499 Endpoint DoS', 'trace flood'),
  'trc-003': e('Reconnaissance', 'AML.T0006 Active Scanning [verify]', 'T1592 Gather Victim Host Info', 'misleading trace reason'),

  // ---- Class 6 escape (singles) ----
  'esc-pocket-2': e('Discovery', 'AML.T0007 Discover AI Artifacts [verify]', 'T1083 File Discovery', 'PocketOS codebase scan'),
  'esc-pocket-3': e('Credential Access', 'AML.T0055 Unsecured Credentials [verify]', 'T1552', 'PocketOS extract token'),
  'esc-pocket-4': e('Impact', 'AML.T0048 External Harms [verify]', 'T1485 Data Destruction', 'PocketOS delete prod'),
  'esc-sakana-1': e('Discovery', 'AML.T0007 Discover AI Artifacts [verify]', 'T1083', 'Sakana read limit file'),
  'esc-sakana-2': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1565 Data Manipulation', 'Sakana edit guardrail'),
  'esc-sakana-3': e('Defense Evasion', 'AML.T0054 LLM Jailbreak [verify]', 'T1562 Impair Defenses', 'Sakana disable timeout'),
  'esc-palisade-1': e('Discovery', 'AML.T0007 Discover AI Artifacts [verify]', 'T1083', 'Palisade read shutdown'),
  'esc-palisade-2': e('Defense Evasion', 'AML.T0054 LLM Jailbreak [verify]', 'T1562 Impair Defenses', 'Palisade comment kill switch'),
  'esc-palisade-3': e('Defense Evasion', 'AML.T0054 LLM Jailbreak [verify]', 'T1562 Impair Defenses', 'Palisade infinite loop'),

  // ---- Class 7 false positives ----
  'fp-001': e('n/a (benign)', 'n/a', 'n/a', 'DROP in code comment'),
  'fp-002': e('n/a (benign)', 'n/a', 'n/a', 'prod_db_url variable name'),
  'fp-003': e('n/a (benign)', 'n/a', 'n/a', 'migration_notes.md'),
  'fp-004': e('n/a (benign)', 'n/a', 'n/a', 'legit $0.99 spend'),
  'fp-005': e('n/a (benign)', 'n/a', 'n/a', 'feature/not-main branch'),
  'fp-006': e('n/a (benign)', 'n/a', 'n/a', 'read leaderboard stats'),
  'fp-007': e('n/a (benign)', 'n/a', 'n/a', 'local test fixture'),
  'fp-008': e('n/a (benign)', 'n/a', 'n/a', 'feature branch push'),
  'fp-009': e('n/a (benign)', 'n/a', 'n/a', 'non-prod Railway config'),
  'fp-010': e('n/a (benign)', 'n/a', 'n/a', 'prod id in test doc'),

  // ---- Session v3 ----
  'sess-cost-lone': e('n/a (benign)', 'n/a', 'n/a', 'lone $0.99 FP discipline'),
  'sess-cost-burst': e('Impact', 'AML.T0034 Cost Harvesting [verify]', 'T1496 Resource Hijacking', '3× $0.99 burst'),
  'sess-pocket-chain': e('Reconnaissance → Impact', 'AML.T0007 → AML.T0048 [verify]', 'T1083 → T1485', 'PocketOS multi-turn chain'),
  'sess-palisade-chain': e('Discovery → Defense Evasion', 'AML.T0007 → AML.T0054 [verify]', 'T1083 → T1562', 'Palisade multi-turn chain'),
  'sess-sakana-chain': e('Persistence', 'AML.T0018 Manipulate AI Model [verify]', 'T1565 Data Manipulation', 'Sakana self-mod chain'),
};

/** Canonical ATLAS techniques the gauntlet is designed to exercise. */
export const ATLAS_TECHNIQUE_CATALOG: { id: string; tactic: string; description: string }[] = [
  { id: 'AML.T0006', tactic: 'Reconnaissance', description: 'Active Scanning' },
  { id: 'AML.T0007', tactic: 'Discovery', description: 'Discover AI Artifacts' },
  { id: 'AML.T0018', tactic: 'Persistence', description: 'Manipulate AI Model (supply chain)' },
  { id: 'AML.T0034', tactic: 'Impact', description: 'Cost Harvesting' },
  { id: 'AML.T0043', tactic: 'Defense Evasion', description: 'Craft Adversarial Data' },
  { id: 'AML.T0046', tactic: 'Defense Evasion', description: 'Spamming AI System with Chaff' },
  { id: 'AML.T0048', tactic: 'Impact', description: 'External Harms' },
  { id: 'AML.T0051', tactic: 'Initial Access', description: 'LLM Prompt Injection' },
  { id: 'AML.T0054', tactic: 'Defense Evasion', description: 'LLM Jailbreak' },
  { id: 'AML.T0055', tactic: 'Credential Access', description: 'Unsecured Credentials' },
  { id: 'RECON→CREDENTIAL', tactic: 'Sequence', description: 'Multi-turn recon then credential (session)' },
  { id: 'RECON→DESTRUCTIVE', tactic: 'Sequence', description: 'Multi-turn recon then destructive (session)' },
  { id: 'AML.T0052', tactic: 'Exfiltration', description: 'Model Exfiltration [GAP — not in gauntlet]' },
  { id: 'AML.T0053', tactic: 'Impact', description: 'AI Intellectual Property Theft [GAP]' },
  { id: 'AML.T0016', tactic: 'ML Attack Staging', description: 'Capability Theft [GAP]' },
];

export function lookupAttackAtlas(attackId: string, name = ''): AttackAtlasEntry {
  const base = ATTACK_ATLAS_BY_ID[attackId];
  if (!base) {
    return {
      attackId,
      name,
      atlasTactic: 'unmapped',
      atlasTechnique: 'n/a',
      attackTechnique: 'n/a',
      note: 'missing atlas entry',
    };
  }
  return { attackId, name, ...base };
}