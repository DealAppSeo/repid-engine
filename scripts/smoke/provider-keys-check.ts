/**
 * provider-keys-check.ts — test EVERY occurrence of each provider key in an
 * env file against that provider's /models endpoint. Prints provider,
 * occurrence index, and HTTP status ONLY — never the key value.
 *
 * Catches the dotenv "first-occurrence-wins" trap: if a key is duplicated and
 * the stale copy is first, the app authenticates with the dead one.
 *
 * Run:
 *   npx ts-node scripts/smoke/provider-keys-check.ts [path-to-env]
 *   (defaults to C:/Users/Cash4/repos/.env.master)
 */
import * as fs from "fs";

const envPath = process.argv[2] ?? "C:/Users/Cash4/repos/.env.master";

const PROVIDERS: Record<string, { key: string; url: string }> = {
  groq: { key: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/models" },
  cerebras: { key: "CEREBRAS_API_KEY", url: "https://api.cerebras.ai/v1/models" },
  deepseek: { key: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/models" },
  deepinfra: { key: "DEEPINFRA_API_KEY", url: "https://api.deepinfra.com/v1/openai/models" },
  fireworks: { key: "FIREWORKS_API_KEY", url: "https://api.fireworks.ai/inference/v1/models" },
};

function occurrences(raw: string, keyName: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${keyName}=(.*)$`));
    if (m && m[1]) out.push(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

async function testKey(url: string, value: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${value}` } });
    return `${res.status} ${res.statusText}`;
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  }
}

async function main() {
  const raw = fs.readFileSync(envPath, "utf8");
  console.log(`\nProvider key check · ${envPath}\n`);
  for (const [name, { key, url }] of Object.entries(PROVIDERS)) {
    const vals = occurrences(raw, key);
    if (vals.length === 0) {
      console.log(`${name.padEnd(10)} ${key}: (not present)`);
      continue;
    }
    for (let i = 0; i < vals.length; i++) {
      const status = await testKey(url, vals[i]!);
      const ok = /^2\d\d/.test(status) ? "✅" : "❌";
      const loaded = i === 0 ? " ← dotenv loads THIS one" : "";
      console.log(`${name.padEnd(10)} occ#${i + 1}/${vals.length}  ${ok} ${status}${loaded}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
