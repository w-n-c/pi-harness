# ADR 0003: Subagents Are Fresh-Context, Not Session Forks

Date: 2026-11-17

## Status

Accepted.

## Context

The `subagent` tool spawns a child `pi --mode json -p --no-session` process and hands it the task prompt on stdin. It does **not** pass `--fork` or `--session`. The child inherits provider configuration and project context files (AGENTS.md, skills resolved via cwd discovery), but it never receives the parent's transcript.

Pi's `--fork`, `/fork`, `/clone`, and `/tree` all operate at the **session** level: they copy or branch *conversation history* into a new session file. "Fork" and "subagent" are therefore different mechanisms that are easy to conflate. That conflation — reaching for a fork when what is wanted is an independent worker — is what this ADR forecloses.

## Decision

**Subagents stay fresh-context by default.** A `subagent` is an independent child run, not a continuation of the parent conversation. It must not silently inherit the parent transcript.

Rationale:

1. **Input-token cost.** A fork hands the child the parent's full context, doubling input-token cost. The penalty is worst under parallel fan-out, where N children each carry a copy of the same inherited prefix.
2. **Review independence.** A reviewer that inherits the author's transcript anchors on the author's intent and reasoning rather than the resulting change. `/code-review` mandates a fresh window precisely to avoid this.
3. **Stale material.** Forks propagate superseded, compacted, and otherwise no-longer-relevant context into the child, where it masquerades as current.
4. **Session-file cost.** Forks persist a new session file, adding clutter. With the new log-tee, an inherited transcript would also be dumped into logs.
5. **Prompt discipline.** The `--no-session` contract forces task prompts to be self-contained, which drives good worker scoping at the call site.

## Consequences

- Subagents re-explore context they need rather than inheriting it. This is a real cost, paid deliberately.
- Prompt caching is not shared with a child, so calls miss the parent's cached prefix (a fork could share it).
- Handoff fidelity is on the caller: a task prompt that omits necessary context cannot be rescued by inherited history.
- **Middle path when continuity is genuinely needed:** pass a curated **capsule** — distilled, task-scoped context injected into an otherwise fresh child — and never an implicit whole-transcript `--fork`. Pi already ships this shape as the [`/handoff`](../../agent/extensions/handoff.ts) extension, which summarizes a session into a focused prompt for a new one.
- If a continuity parameter is ever added to `subagent`, it must be an explicit opt-in capsule. Implicit forking of the parent transcript is never acceptable.
