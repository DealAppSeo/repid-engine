# Agent Hook Discovery

## Where in the runLoop work is performed
The main agent work is performed within the `processTask(task)` function inside `ConstitutionalAgentV4.js`. 
Specifically, it calls `this.callLLM(context)` to generate a response based on the task description and agent constitution.

## Where work-completion is signaled
Work completion is signaled by updating the `trinity_tasks` table in Supabase. The agent sets `status: 'done'`, saves the `result`, and updates confidence/belief metrics. It also calls `this.spawnNextStep()` which can create peer-verification tasks for other agents.

## Where agent-to-agent communication currently happens
Communication happens exclusively through the database (Supabase).
- Tasks are created in `trinity_tasks` with an `assigned_to` field or left unassigned.
- Agents poll `trinity_tasks` in their `runLoop()` via `getNextTask()`.
- Peer-review communication is handled via `[VERIFY]` tasks which are spawned and claimed by other agents.

## Whether base class has any pre/post-task hooks already
There are no explicit decorator-style pre/post hooks. However, `processTask()` handles a linear pipeline:
1. `claimTask`
2. `log('task_processing')`
3. `callLLM(context)`
4. `evaluateResult()`
5. DB Update to `done` or `pending_clarification`
6. `spawnNextStep()`
7. `updateReputation()`

## Whether agents currently produce any kind of "receipt" or "log" upon work completion
Agents produce an "artifact" by calling the `save_artifact` tool which inserts into the `trinity_artifacts` table. They also log to `trinity_agent_logs`. However, they **do not** currently produce a cryptographically verifiable HyperDAG receipt or interact with the `receiptIssuer`.
