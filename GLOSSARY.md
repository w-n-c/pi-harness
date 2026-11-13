# Pi Agent Harness

A vendor-agnostic personal coding agent environment that pairs a minimal core toolset and branching session tree with on-demand skills, deterministic guardrails, and isolated subagents.

## Language

**Harness**:
The primary interactive agent loop, session tree, and tool execution environment that orchestrates engineering workflows independently of the underlying model provider.
_Avoid_: Platform, IDE, wrapper

**Skill**:
An on-demand workflow or discipline definition loaded into the session context only when relevant or explicitly invoked, keeping the baseline system prompt minimal.
_Avoid_: System prompt rule, global instruction, plugin

**Subagent**:
An isolated, fresh-context child agent execution used to offload noisy exploration, parallel review, or scoped ticket implementation without polluting the primary session context.
_Avoid_: Background thread, helper, worker

**Lifecycle Guardrail**:
A deterministic policy check triggered automatically at a tool or repository boundary to block destructive actions or enforce verification without spending prompt tokens.
_Avoid_: Prompt reminder, safety instruction

**Model Tier**:
A vendor-agnostic capability level (such as `deep`, `balanced`, or `fast`) assigned to a skill or subagent role and resolved in code to a concrete provider model and reasoning effort.
_Avoid_: Hardcoded model ID, frontmatter model string

