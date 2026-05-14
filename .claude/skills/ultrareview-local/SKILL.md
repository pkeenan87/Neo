---
name: ultrareview-local
description: Replicate Claude Code's /ultrareview slash command locally when the cloud-hosted ultra review is failing, unavailable, blocked by ZDR/Bedrock/Vertex, or out of free runs. Use this skill whenever the user asks for an "ultra review", a deep multi-agent code review, a pre-merge fleet review, parallel reviewer agents, verify-before-report code review, or says the cloud /ultrareview is crashing or eating their quota. Spawns a fleet of 5-8 parallel subagents using the Task tool, each reviewing the diff through a distinct lens (logic, security, concurrency, edge cases, performance, executor/agent-platform hygiene, with optional splits), then runs a strict verification stage before synthesizing a consolidated report. Bias is toward false negatives over false positives.
---

# ultrareview-local

A local replica of Claude Code's `/ultrareview` slash command. Spawns parallel reviewer subagents through a verify-before-report pipeline, then synthesizes the findings. Use this when the cloud `/ultrareview` is failing, blocked, or unavailable — or when you want this pattern outside Claude Code (Bedrock, Vertex, ZDR orgs, automated pipelines).

## When to use

Trigger this skill when:

- The user explicitly asks to replicate, mimic, replace, or substitute for `/ultrareview`.
- The cloud `/ultrareview` is crashing, archiving sessions without findings, or has burned their free runs.
- A multi-agent / fleet / parallel reviewer code review is requested.
- A pre-merge review of a diff or PR is requested with an explicit emphasis on accuracy or verification.
- The user is in an environment where `/ultrareview` doesn't exist (Bedrock, Vertex, Microsoft Foundry, ZDR-enabled org, CI pipeline).

Do NOT use this skill for:

- Style nits, naming, formatting, or "considerations". This skill reports bugs only.
- Whole-repo audits. Scope is always a diff. Tell the user to use a different approach for full audits.
- Lightweight reviews on small changes — `/review` (or just "review my diff") is the right tool. This skill is the heavy hammer.

## Requirements

- An environment with a `Task` tool (or equivalent) for spawning parallel subagents. In Claude Code that's built in. On Claude.ai, the agents must be run sequentially in the same context — explicitly note this to the user and warn them the parallelism that makes ultra review robust will be lost.
- A git working tree with a default branch to diff against, OR a PR number that can be checked out.
- File-read and shell access for the orchestrator.

## How to run

### Step 1 — Decide fleet size

Default fleet is **6 agents** (the five standard lenses plus an agent-platform hygiene lens that matters whenever the diff touches LLM tool-calling, agent executors, prompt construction, or RBAC at an executor boundary).

Offer the user the option to bump to **7 or 8 agents** in any of these conditions:

- Diff is large (rule of thumb: more than ~800 lines changed, or more than ~15 files touched).
- Diff touches payments, auth, crypto, PII handling, or anything regulated.
- The user explicitly says "high stakes", "production-critical", "before a release", or names a sensitive surface.
- The user asks for it.

The split rules for bumping:

- **7 agents** → split Agent 2 (Security) into **2a Authn/Authz** and **2b Injection & Data Exposure**.
- **8 agents** → also split Agent 3 (Concurrency) into **3a Races & Ordering** and **3b Transactions & Idempotency**.

If the user doesn't say, ask once: "Run the standard 6-agent fleet, or bump to 7-8 for higher coverage on this diff?" Then proceed.

### Step 2 — Scope the review

Run, in this order:

```bash
git rev-parse --abbrev-ref HEAD
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo "main"
# Use the resolved default branch below. Substitute 'main' if resolution failed and confirm with the user.
git diff $(git merge-base HEAD <default-branch>)...HEAD
git log $(git merge-base HEAD <default-branch>)...HEAD --oneline
git diff --stat $(git merge-base HEAD <default-branch>)...HEAD
```

If reviewing a GitHub PR instead of the local working tree:

```bash
gh pr checkout <pr-number>
# Then run the diff commands above.
```

If `git merge-base` returns nothing useful (squash-merge history, detached HEAD, etc.), fall back to `git diff origin/<default-branch>...HEAD` and tell the user what you fell back to.

**Read every changed file in full**, not just the diff hunks. Verification in Step 4 depends on having full surrounding context. Cache the file contents so subagents inherit them.

### Step 3 — Spawn the fleet in parallel

Use the `Task` tool. Each subagent receives:

1. The full diff.
1. The full contents of every changed file.
1. The lens-specific instructions below.
1. The output format contract.
1. The hard rule: **do not include style, naming, or "consider" findings. Bugs only.**

**Output format contract for every subagent:**

```
{
 agent: "<agent-name>",
 findings: [
   {
     severity: "critical" | "high" | "medium" | "low",
     file: "<path>",
     line: <int or range>,
     description: "<what is wrong>",
     why_it_breaks: "<the failure mode in concrete terms>",
     suggested_fix: "<minimal change>",
     reproduction: "<concrete input, state, or sequence that triggers it>"
   }
 ]
}
```

#### Standard 6-agent fleet

**Agent 1 — Logic & Correctness**
Off-by-one, inverted conditionals, broken invariants, missing returns, null/undefined deref, type confusion, wrong error propagation, dead branches that should be live, live branches that should be dead, sign errors, unit mismatches (ms vs s, bytes vs MB).

**Agent 2 — Security**
Authn/authz bypass, injection (SQL/command/prompt/template/header), SSRF, path traversal, secret or PII exposure (logs, error messages, responses), missing input validation, broken access control checks, unsafe deserialization, regex DoS, vulnerable dependencies introduced, insecure defaults, missing CSRF/CORS, weak crypto choices.

**Agent 3 — Concurrency & Data Integrity**
Races, non-atomic read-modify-write, missing transactions or locks, double-submission, idempotency gaps, stale cache reads, ordering assumptions across async boundaries, unawaited promises, deadlocks, lost updates, transaction scope errors, retry-without-idempotency-key.

**Agent 4 — Edge Cases & Error Handling**
Empty/null/zero/max-size inputs, malformed payloads, network and partial failures, swallowed exceptions, retry storms, missing or wrong timeouts, resource leaks (handles, sockets, file descriptors), unhandled promise rejections, error-path branches that are themselves broken, fallback paths that mask real failures.

**Agent 5 — Performance & Resource Use**
N+1 queries, unbounded loops or recursion, blocking I/O on hot paths or event loops, missing pagination, memory leaks, inefficient algorithms where the input can grow, cache thrash, excessive serialization, synchronous calls inside loops over network resources, missing indexes implied by new query patterns.

**Agent 6 — Executor / Agent-Platform Hygiene** *(applies whenever the diff touches LLM tool-calling, agent executors, prompt construction, MCP servers, RAG retrieval, or RBAC at an executor boundary)*
Prompt injection surface (untrusted content reaching the system or tool layer without containment), tool/function-call argument validation, RBAC enforcement at the executor boundary (not just at the API edge), audit-log completeness for tool invocations and their results, scope creep in tool definitions (tools that can do more than the prompt advertises), unsafe retrieval (RAG returning content that becomes instructions), secrets reaching the model context, MCP server allowlisting and JSON-RPC schema validation, stdio MCP bypassing the network governance layer, missing redaction on model inputs/outputs, conversation-state leakage across tenants or users.

If the diff has no agent-platform surface, Agent 6 reports `findings: []` and exits cleanly. Do not force it to invent findings.

#### Bumping to 7 agents

Replace Agent 2 with:

**Agent 2a — Authentication & Authorization**
Auth bypass, broken access control, privilege escalation paths, missing authz checks on new endpoints or handlers, session fixation, token reuse across scopes, IDOR (insecure direct object reference), tenant-isolation breaks, role checks done client-side that should be server-side, JWT validation gaps, missing re-authentication for sensitive actions.

**Agent 2b — Injection & Data Exposure**
SQL/command/prompt/template/header injection, SSRF, path traversal, unsafe deserialization, XXE, secret or PII exposure in logs/responses/errors, regex DoS, vulnerable dependency introductions, weak crypto, insecure randomness for security-sensitive use, missing output encoding, CSRF/CORS misconfig.

#### Bumping to 8 agents

Also replace Agent 3 with:

**Agent 3a — Races & Ordering**
Non-atomic read-modify-write, ordering assumptions across async boundaries, unawaited promises, missing await on critical paths, deadlock risk, lost updates from concurrent writes, time-of-check-to-time-of-use, event-loop blocking that changes ordering.

**Agent 3b — Transactions & Idempotency**
Missing transactions where they're needed, transaction scope errors, double-submission paths, missing idempotency keys on retry-eligible endpoints, retry-without-idempotency-key, stale cache reads, exactly-once assumptions on at-least-once delivery, partial-failure rollback gaps.

### Step 4 — Verification (the part that makes this "ultra")

This is non-negotiable. Without this stage you have `/review`, not `/ultrareview`.

For **every** finding returned by every subagent, the orchestrator (you, not the subagents) must:

1. Re-read the cited code in full file context.
1. Trace whether the alleged bug actually fires given real call sites, type definitions, framework-level guards, upstream validation, and surrounding logic.
1. Classify the finding as one of:
- **VERIFIED** — A concrete input, state, or sequence triggers it. Include the trigger in the final report.
- **PLAUSIBLE** — The bug depends on an assumption about runtime state, external behavior, or configuration that can't be confirmed statically. State the exact assumption.
- **REJECTED** — Closer reading shows the concern doesn't hold. State why in one sentence.

Do not pass through any finding that hasn't been through this stage. If verification is ambiguous, classify as PLAUSIBLE — never silently upgrade to VERIFIED.

### Step 5 — Synthesize the report

Produce one consolidated report in this structure:

```
## Ultra Review — <branch> vs <default-branch>

Fleet: <N> agents
Diff: <files changed>, <insertions>/<deletions>
Verification: <#verified> verified, <#plausible> plausible, <#rejected> rejected

### Verified findings
(sorted by severity; multi-agent consensus findings flagged at the top)

#### [CRITICAL] <file:line> — <one-line summary>  [multi-agent consensus: agents 1, 4]
- Why it breaks: ...
- Trigger: ...
- Suggested fix: ...

(repeat)

### Plausible findings
(each with the assumption that would need to be confirmed)

#### [HIGH] <file:line> — <one-line summary>
- Assumption: <what would need to be true at runtime for this to fire>
- Why it would break if the assumption holds: ...
- Suggested fix: ...

### Conflicts
(places where one agent flagged something another would have considered fine)

#### <file:line>
- Agent X (<lens>) said: ...
- Agent Y (<lens>) said: ...
- Orchestrator note: ...

### Rejected findings (appendix)
(one-line each, with one-sentence reasoning, so the user can audit the orchestrator's calls)
```

## Hard rules

1. Bugs only. No style, naming, formatting, doc-comment, or "consider" findings. If a subagent emits one, drop it during synthesis.
1. Verification is mandatory. Any finding that hasn't passed Step 4 does not appear in the report.
1. Bias toward false negatives over false positives. The benchmark to beat is the published <1% false-positive rate on Anthropic's cloud ultra review. It is better to miss a real bug than to bury the user in noise.
1. Multi-agent consensus is a signal, not a guarantee. Two agents can be wrong in the same way (especially across the security splits). Verify independently.
1. If a finding requires running the code to confirm, it stays PLAUSIBLE. Don't guess.
1. Scope is always the diff, never the whole repo. If the user wants a whole-repo audit, tell them this is the wrong tool.

## Limitations versus the cloud version

Be honest with the user about what's different:

- No dedicated cloud sandbox. Subagents share the orchestrator's compute and context budget, so very large diffs (~thousands of lines, dozens of files) will exhaust context faster than the cloud version. If the diff is too large, suggest splitting by directory and running the skill per slice.
- No runtime reproduction. The cloud version can spin up a sandbox and actually execute proofs-of-concept; this skill is static-analysis only. That's why PLAUSIBLE exists as a category.
- No persistent run history. There's no "task ID" to refer back to. Save the report to a file if needed.

## Quick reference — fleet decision

|Diff size              |Surface                                              |Fleet                    |
|-----------------------|-----------------------------------------------------|-------------------------|
|< 200 lines, low-stakes|any                                                  |Standard 6               |
|200–800 lines          |non-sensitive                                        |Standard 6               |
|200–800 lines          |auth/payments/PII/crypto                             |7 (split security)       |
|> 800 lines            |any                                                  |7, ask about 8           |
|any                    |concurrent writes, transactional, queue/retry surface|8 (split concurrency too)|
|any                    |no LLM/agent/executor/RAG code touched               |Drop Agent 6; run 5      |
