# ADR 0002: OpenRouter/DeepSeek Default and a Provider-Agnostic Subagent

Date: 2026-04-18

## Status

Accepted. Supersedes the provider and subagent decisions in [ADR 0001](0001-agy-provider-bridge-and-model-tiers.md); the Model Tier concept it introduced is retained.

## Context

ADR 0001 chose the Antigravity CLI (`agy`) as the reasoning engine because Pi's `google-antigravity` provider had been removed and free-tier Google API keys rate-limited immediately. That decision treated `agy` as the default and implemented the `subagent` tool by shelling out to `agy --model <id>`, so subagents were bound to the same vendor as the main loop.

Two things changed:

1. **The `agy` quota ran out for an extended period**, forcing a switch to a direct API provider mid-session. The harness already had an `openrouter` column in `skill-models.json`, so the switch was a `settings.json` edit — but the `subagent` tool kept spawning `agy`, which broke every workflow that fans out to child runs (`implement-spec`, `code-review`, `triage`).
2. **Dropping the `effort` field from the OpenRouter tiers silently disabled thinking.** The router passed `undefined` to `pi.setThinkingLevel()`, which `clampThinkingLevel()` resolves to the model's lowest supported level (`off`). The intent was "DeepSeek ignores effort"; the effect was "DeepSeek never thinks."

## Decision

- **Default provider is OpenRouter with DeepSeek models.** `settings.json` sets `defaultProvider: "openrouter"`. Per-model routing preferences live in `models.json` via `compat.openRouterRouting`.
- **`subagent` is provider-agnostic.** It spawns a child `pi --mode json -p` process ([agent/extensions/subagent.ts](../agent/extensions/subagent.ts)) that inherits the active provider, harness extensions, and guardrails. Tier resolution still maps a `tier` to a model + optional thinking level, but nothing in the tool names a vendor.
- **`agy` is demoted to an optional fallback.** [agent/extensions/agy-bridge.ts](../agent/extensions/agy-bridge.ts) keeps only the provider registration; it is dormant unless `defaultProvider` is `agy`. It exists solely to cover environments with no direct API key.
- **`effort` is optional and only applied when present.** A tier without `effort` leaves the session's thinking level untouched, so an omitted value can never mean "thinking off." OpenRouter/DeepSeek tiers declare legal thinking levels (`high`, `low`); DeepSeek does not map `medium`.

## Consequences

- Skills, hooks, and `SKILL.md` files are untouched by provider changes; only `settings.json` and the active column in `skill-models.json` matter.
- Subagent workflows survive a provider switch, since the child inherits the parent's provider rather than a hardcoded CLI.
- The `agy` bridge is retained but carries no default weight. Removing it entirely is a one-file delete once the direct-API key is permanent.
- Tier `effort` values are provider-specific and must be a level the model actually maps; `skill-models.json` documents the legal set per provider.
