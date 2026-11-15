# ADR 0001: Bridge Pi to Antigravity CLI and Route Skills via Vendor-Agnostic Model Tiers

> **Superseded (partially) by [ADR 0002](0002-openrouter-default-and-provider-agnostic-subagent.md).**
> The Model Tier concept stands, but `agy` is no longer the default provider and the
> `subagent` tool no longer shells out to `agy`. Read ADR 0001 for history only.

Pi's built-in `google-antigravity` provider was removed in v0.71.0, and free-tier Google Gemini API keys hit immediate utilization rate limits. Meanwhile, interactive planning workflows (`/skill:grill-with-docs`) require multi-turn conversations in Pi's main loop, whereas research, code review (`/skill:code-review`), and parallel ticket builds (`/skill:implement-spec`) require isolated fresh-context child runs.

We register a custom `"agy"` provider (`pi.registerProvider("agy", ...)`) that uses `agy -p --output-format stream-json` as the reasoning engine while keeping execution of Pi's four core tools (`read`, `write`, `edit`, `bash`) inside Pi so TypeScript `tool_call` guardrails and TUI diffs work identically to native API providers. Alongside it, we register a `subagent` tool (`pi.registerTool`) for single and parallel child runs, and resolve skill model assignments deterministically in TypeScript code via a vendor-agnostic **Model Tier** (`deep`, `balanced`, `fast`) table in `~/.pi/agent/skill-models.json` rather than hardcoding vendor model names inside `SKILL.md` files.

## Consequences

- Switching away from the Gemini Pro / `agy` subscription later requires only changing `defaultProvider` in `settings.json` and selecting another provider column in `skill-models.json`; no skills, hooks, or workflows change.
- Shared `SKILL.md` files in `~/.agents/skills/` stay unmodified and token-lean.
