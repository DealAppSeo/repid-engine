-- Firecrawl MCP registration (CC2 2026-05-26) — data seed, NOT a schema migration.
-- Already applied to prod (qnnpjhlxljtqyigedwkb) this sprint; kept here for review/reproducibility.
-- Idempotent (guarded by NOT EXISTS).
--
-- Initial access scope: trinity-nexus + trinity-torch ONLY (research agents, cost control during
-- rollout). Scope is ENFORCED in src/engine/mcp.ts (firecrawlAllowedAgents); these rows are global.
-- Real calls require FIRECRAWL_API_KEY on Railway (unset → mcp.ts blocks gracefully, no stub).

-- 1) Discovery catalog
INSERT INTO agent_mcp_catalog (mcp_name, mcp_url, category, relevance_score, use_case, install_command, env_vars_needed, priority, notes)
SELECT 'Firecrawl', 'https://api.firecrawl.dev', 'research', 9,
  'Live web scraping/search/crawl for research-oriented agents (ground-truth site capture, doc lookup).',
  'npx -y firecrawl-cli@latest init --all  (server uses REST: POST https://api.firecrawl.dev/v2/scrape)',
  ARRAY['FIRECRAWL_API_KEY'], 'week1',
  'CC2 2026-05-26. Scope: trinity-nexus + trinity-torch ONLY (cost control); enforced in mcp.ts (FIRECRAWL_ALLOWED_AGENT_IDS). ~1 credit/scrape; calls logged to trinity_tool_usage.outcome (cost_credits/cost_usd). Expand after observing usage.'
WHERE NOT EXISTS (SELECT 1 FROM agent_mcp_catalog WHERE mcp_name='Firecrawl');

-- 2) Callable, approved tool registry (read by callMCPWithGuardrails)
INSERT INTO repid_mcp_tools (tool_name, mcp_endpoint, constitutional_cue, repid_bonus, requires_conservator_approval, approved, usage_count)
SELECT 'firecrawl', 'https://api.firecrawl.dev/v2/scrape',
  'CONSTITUTIONAL CUE — Firecrawl Web Research MCP: (1) Constitutional audit required before any call. (2) ACCESS SCOPE: trinity-nexus + trinity-torch ONLY for initial rollout (cost control); other agents are blocked at the client allowlist. (3) Every call is metered — log cost (credits + USD) to trinity_tool_usage.outcome with agent_id, query, timestamp. (4) Rate-limited per agent_id (default 20/hour). (5) Never scrape to exfiltrate private data or formula constants; research/ground-truth only. (6) Prefer summary format to minimize credits. REPID BONUS: +10 for research that demonstrably improves a Symphony decision; +6 for tool use.',
  6, false, true, 0
WHERE NOT EXISTS (SELECT 1 FROM repid_mcp_tools WHERE tool_name='firecrawl');
