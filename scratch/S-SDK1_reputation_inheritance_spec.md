# S-SDK1 — Reputation Inheritance Spec

**Date:** 2026-05-30  
**Design-only.** XC isolated worktree.

## Core Rule

When Agent A delegates a task/tool call to Agent B:

**B.effective_repid = MIN(B.own_repid, A.delegator_repid)**

This value is computed at the moment of delegation / tool_call and is used for all downstream gating (capability checks, authority, HITL floors, etc.) on that specific delegated action.

## Data Model

### Primary Table (depends on CC S-AUD1)

**tool_call_log**
```sql
CREATE TABLE tool_call_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          text,
  parent_agent_id     uuid REFERENCES repid_agents(id),
  child_agent_id      uuid REFERENCES repid_agents(id),
  tool_name           text,
  delegated_at        timestamptz DEFAULT now(),
  effective_repid_at_time int,        -- the MIN value used
  delegation_depth    int,            -- 1-based
  parent_delegation_id uuid REFERENCES tool_call_log(id)
);
```

### Supporting (recommended)

**delegation_edges** (for fast ancestry)
```sql
CREATE TABLE delegation_edges (
  id uuid PRIMARY KEY,
  from_agent uuid,
  to_agent uuid,
  started_at timestamptz,
  ended_at timestamptz,
  max_depth_reached int
);
```

**repid_agents** extensions (lightweight)
- `delegation_parent_id uuid` (nullable)
- `effective_repid_cache int` (nullable, refreshed on delegation events)

## Gating Points in constitutional-agent-base.js

From code inspection:

1. **delegateToTool (line ~929)**  
   - Before calling `mcpManager.routeToolCall`, resolve the full delegation ancestry for the current agent.  
   - Compute effective_repid.  
   - Log the call to `tool_call_log` with depth and effective value.  
   - If effective_repid < 70 → create HITL request and do not execute the tool.

2. **Task claim / processTask / processTaskContract paths**  
   - At claim time for any delegated task, attach or resolve delegation context (via task metadata or new column).  
   - Use effective_repid (not raw own_repid) for capability/authority/tier decisions inside the loop.

3. **spawnNextStep / recursive spawning**  
   - Propagate delegation context when spawning follow-ups from a delegated task.  
   - Enforce max depth = 3 on every spawn.

4. **Genesis / inheritance paths** (existing "inherits" logic around line 514)  
   - Ensure pre-genesis wisdom does not bypass the effective RepID floor for delegated work.

5. **runLoop entry / claim logic**  
   - When a task arrives via delegation, the effective RepID must be the one used for any RepID-based gating in that iteration.

## Edge Cases

- **Circular delegation** (A→B→A): Detect via visited ancestry set. Reject or treat as depth violation.
- **Self-delegation**: Effective = own_repid (no-op).
- **Delegation to unregistered agent**: Target has no repid_agents row → effective_repid = 0 → forces HITL/rejection.
- **Depth > 3**: Hard stop. The 4th level cannot perform privileged actions.
- **RepID change mid-chain**: Snapshot `effective_repid_at_time` at delegation moment. Later changes do not retroactively affect already-logged calls.
- **HITL floor (70)**: Absolute. Even a high-RepID agent acting under a low-RepID delegator must escalate if effective < 70.

## Break-Risk Analysis (current codebase)

- `delegateToTool` currently has almost no RepID gating — **high risk**. Adding the MIN calculation + depth check + mandatory logging will change behavior for all MANAGER-mode agents.
- Many call sites (processTask, spawnNextStep, etc.) do not currently carry delegation context. Will require propagation (task metadata or async context).
- `tool_call_log` table does not exist yet (S-AUD1 dependency). Logging must be graceful/no-op until that table lands.
- Existing "spawn control" logic must compose with the new depth rule.
- Agents that read raw `this.reputationScore` or direct `getRepID()` will see different effective values once the rule is active.
- Performance: ancestry walks must be indexed (use delegation_edges + proper indexes on tool_call_log).

**Recommendation**: Gate the entire inheritance feature behind `DELEGATION_INHERITANCE=v1` (or similar) so it can be enabled only after S-AUD1, the critical RLS batches, and after the S-REP3 explainability view are live.

---

**End of S-SDK1_reputation_inheritance_spec.md**