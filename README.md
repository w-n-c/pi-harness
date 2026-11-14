# Pi Agent Harness (`~/.pi`)

A vendor-agnostic personal coding agent harness built on [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`). It keeps the always-on toolset minimal (`read`, `write`, `edit`, `bash` + `codemode` + `subagent`), loads workflows on demand via [Matt Pocock's skills](https://github.com/mattpocock/skills), routes skills to vendor-agnostic **Model Tiers** (`deep`, `balanced`, `fast`) in code, and enforces 2-layer deterministic safety guardrails.

---

## 1. Prerequisites & Optimal CLI Tools

Agents perform best when standard Unix/CLI tools are available on `PATH` (avoiding context-bloating wrapper plugins).

### Core Agent & Runtime Binaries

```bash
# 1. Pi Coding Agent (installs managed binary to ~/.pi/agent/bin/pi and ~/.local/bin/pi)
curl -fsSL https://pi.dev/install.sh | sh
# Or update an existing install:
pi update

# 2. Language runtimes & JSON tooling via mise
mise use -g node@latest bun@latest python@latest jq@latest

# 3. Antigravity CLI (used by agy-bridge while on Gemini Pro subscription)
agy --version
```

### Essential CLI Tools for Agent Performance

Install these via your system package manager (`pacman`, `apt`, `dnf`, or `mise`) so `bash` tool calls stay fast and token-efficient:

| Tool | Binary | Why the Agent Needs It |
| :--- | :--- | :--- |
| **ripgrep** | `rg` | Fast regex code search (Pi's system prompt explicitly tells the model to use `rg`) |
| **fd** | `fd` | Fast file discovery that respects `.gitignore` |
| **jq** | `jq` | Inspecting/transforming JSON without brittle inline Python/Node one-liners |
| **git** | `git` | Version control, diffs, and branch management |
| **fzf** | `fzf` | Interactive fuzzy selection |
| **curl** | `curl` | HTTP requests and API checks |
| **ast-grep** *(optional)* | `sg` | Structural AST search/refactoring across Rust, Zig, TypeScript, C, and Python |
| **GitHub CLI** *(optional)* | `gh` | Required only when using GitHub Issues/PRs with `/skill:to-tickets`, `/skill:triage`, or `/skill:pr` |

Quick check for all recommended CLI tools:

```bash
for cmd in pi agy git rg fd jq fzf curl bun node python3; do
  command -v "$cmd" >/dev/null && echo "OK: $cmd" || echo "MISSING: $cmd"
done
```

---

## 2. Installing & Updating Matt Pocock's Skills

Pi 1.5+ automatically discovers skills in `~/.agents/skills/` (the cross-agent standard directory) and `~/.pi/agent/skills/`.

### Install or update the skill pack

```bash
# Install all Matt Pocock skills globally into ~/.agents/skills/
npx skills add mattpocock/skills -g

# Keep ~/.gemini/skills symlinked to the same single source of truth for agy:
ln -sfn ~/.agents/skills ~/.gemini/skills
```

### Using the skills inside Pi

Skills with `disable-model-invocation: true` stay out of the system prompt until you invoke them with `/skill:<name>`:

- `/skill:ask-matt <question>` — Ask which workflow/skill fits your current task
- `/skill:setup-matt-pocock-skills` — Run once in a new project repo to configure its issue tracker (`.scratch/` or GitHub), triage labels, and `GLOSSARY.md` / ADR layout
- `/skill:grill-with-docs` — Relentless design-tree interview that updates `GLOSSARY.md` and `docs/adr/`
- `/skill:to-spec` → `/skill:to-tickets` — Synthesize a spec and vertical-slice tickets
- `/skill:implement` — Build a ticket/feature using `/skill:tdd` at agreed seams followed by a two-axis `/skill:code-review`
- `/skill:diagnosing-bugs` — Tight feedback-loop bug diagnosis
- `/skill:retro` — Post-session retrospective to improve the harness environment

*(Note: `agent/extensions/skill-router.ts` automatically expands Claude-Code-style `"Call the Skill tool..."` directives inside `SKILL.md` files so chained skills load seamlessly in Pi.)*

---

## 3. Adding Custom Skills & Configuring Model Tiers

### Adding a new skill

Create `<skill-name>/SKILL.md` in one of three places:
1. **Cross-agent global (`~/.agents/skills/<skill-name>/SKILL.md`)**: Shared between both `pi` and `agy`.
2. **Pi-only global (`~/.pi/agent/skills/<skill-name>/SKILL.md`)**: Loaded only by `pi`.
3. **Project-local (`.pi/skills/<skill-name>/SKILL.md` or `.agents/skills/<skill-name>/SKILL.md`)**: Checked into a specific project repository.

Minimal `SKILL.md` template:

```markdown
---
name: my-skill
description: "When and why the agent should use this skill (required, max 1024 chars)."
disable-model-invocation: true
---

# My Skill Instructions

Step-by-step instructions here...
```

> Set `disable-model-invocation: true` if you only want the skill loaded when you explicitly type `/skill:my-skill` (zero system-prompt token cost on normal turns). Omit it if you want the agent to auto-discover and read the skill when a task matches `description`.

### Assigning a skill to a Model Tier (`agent/skill-models.json`)

To keep `SKILL.md` files free of vendor-specific model names, [agent/skill-models.json](file:///home/w-n-c/.pi/agent/skill-models.json) maps skill names to three semantic **Model Tiers** (`deep`, `balanced`, `fast`) in TypeScript code:

```json
{
  "skills": {
    "my-skill": "deep"
  }
}
```

- **Inline one-off override on any prompt**: Append `@deep`, `@balanced`, `@fast`, or `@<model-id>` to any message (e.g., `/skill:implement @deep build parser`).
- **Session command**: Run `/tier deep`, `/tier balanced`, `/tier fast`, `/tier lock` (disable auto-switching), or `/tier auto` (re-enable auto-switching).

---

## 4. Adding & Managing MCP Servers

Pi 1.5+ has native MCP support (`builtin:mcp` + `builtin:tool-search` + `builtin:codemode`). **Do not install `pi-mcp-adapter`.**

### Golden Rules for MCP

1. **Never add an MCP server for something with a good CLI** (`git`, `rg`, `jq`, `cargo`, `zig`, `bun`, `docker`, `psql`, `sqlite3`, `gh`). Standard CLIs via `bash` cost zero schema tokens.
2. **Always set `"exposure": "deferred"`** so MCP tool schemas stay out of your system prompt until the agent searches for them via `tool_search`.
3. **When to add an MCP server:**
   - **Web Search & Library Docs**: Already configured globally in [agent/mcp.json](file:///home/w-n-c/.pi/agent/mcp.json) via `exa` (`https://mcp.exa.ai/mcp`) and `context7` (`@upstash/context7-mcp`).
   - **Frontend Browser / DOM Inspection**: Add `@playwright/mcp` to a web project's local `.pi/mcp.json`.
   - **SaaS APIs with OAuth (Sentry, Figma, Linear, Notion)**: Add to `.pi/mcp.json` and run `/mcp login <name>`.

### Commands to add or inspect MCP servers

```bash
# Add a project-local (-l) stdio MCP server (writes to .pi/mcp.json)
pi mcp add -l playwright -- npx -y @playwright/mcp

# Add a remote HTTP MCP server
pi mcp add -l sentry --url https://mcp.sentry.dev/mcp

# Check server connections from the shell or inside Pi TUI
pi mcp list
```

After adding a server, ensure `"exposure": "deferred"` is set on the entry in `mcp.json`, and run `/reload` (or `/mcp`) inside Pi.

---

## 5. Switching Model Providers Later

While on your Gemini Pro subscription, [agent/settings.json](file:///home/w-n-c/.pi/agent/settings.json) sets `"defaultProvider": "agy"`, which routes through [agent/extensions/agy-bridge.ts](file:///home/w-n-c/.pi/agent/extensions/agy-bridge.ts) with a **160K Smart Zone** context window cap (triggering auto-compaction around ~140K tokens).

To switch to a direct API provider (`anthropic`, `openai`, `google`, `openrouter`, or local `llama.cpp`) later:

1. Authenticate in Pi:
   ```text
   /login
   ```
2. Update `"defaultProvider"` and `"defaultModel"` in [agent/settings.json](file:///home/w-n-c/.pi/agent/settings.json) (or press `Ctrl+S` inside `/model`).
3. Verify your provider's `deep` / `balanced` / `fast` model IDs in [agent/skill-models.json](file:///home/w-n-c/.pi/agent/skill-models.json).

---

## 6. Repository Layout & Verification

```text
~/.pi/
├── AGENTS.md                        # Root instructions & skill pointers
├── GLOSSARY.md                      # Domain vocabulary
├── docs/
│   ├── adr/                         # Architecture Decision Records
│   └── agents/                      # Issue tracker, triage labels, domain & MCP rules
├── agent/
│   ├── settings.json                # Default provider, Smart Zone compaction thresholds
│   ├── skill-models.json            # Vendor-agnostic Model Tier routing table
│   ├── mcp.json                     # Global deferred MCP servers (exa, context7)
│   ├── guardrails-bin/git           # Layer 2 OS-level PATH git shim
│   └── extensions/
│       ├── agy-bridge.ts            # Custom 'agy' provider + 'subagent' tool
│       ├── skill-router.ts          # Deterministic tier switcher + chained skill loader
│       ├── guardrails.ts            # Layer 1 tool_call gates + 3-strike circuit breaker
│       └── handoff.ts               # /handoff session transfer command
└── tests/                           # Seam unit & integration tests
```

Run the test suite at any time with:

```bash
bun test
```
