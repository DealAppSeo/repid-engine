/**
 * _good-env-preload.js — TEMPORARY workaround for duplicate-key shadowing in
 * .env.master. dotenv keeps the LAST occurrence of a duplicated key within a
 * file; .env.master has a stale 2nd GROQ_API_KEY (401) below the good one (200),
 * so the app authenticates with the dead key.
 *
 * This preloader loads .env.master with normal last-wins semantics (matching the
 * app), but forces GROQ_API_KEY to its FIRST (valid) occurrence, and sets values
 * with override so the committed dummy .env can't clobber them.
 *
 * Delete this once .env.master is de-duplicated (remove the stale 2nd
 * GROQ_API_KEY line). Prints nothing — never emits secret values.
 *
 * Use:  npx ts-node -r ./scripts/smoke/_good-env-preload.js <script> [args]
 */
const fs = require("fs");
const ENV_PATH = "C:/Users/Cash4/repos/.env.master";

const raw = fs.readFileSync(ENV_PATH, "utf8");
const vals = {};
let firstGroq;
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  const k = m[1];
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (k === "GROQ_API_KEY" && firstGroq === undefined) firstGroq = v; // remember valid first
  vals[k] = v; // last-wins, matches dotenv
}
if (firstGroq !== undefined) vals["GROQ_API_KEY"] = firstGroq; // force the valid occurrence
// PRELOAD_SKIP=KEY1,KEY2 forces a provider key EMPTY (not omitted) so the committed .env can't
// re-inject it — lets an experiment exclude a provider (e.g. a throttling one). Empty string is
// present-but-falsy, so dotenv won't override it and the provider's `if (key)` guard skips it.
const skip = new Set((process.env.PRELOAD_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean));
for (const k of Object.keys(vals)) process.env[k] = skip.has(k) ? "" : vals[k];
for (const k of skip) process.env[k] = ""; // ensure skipped keys are set-empty even if absent from file
