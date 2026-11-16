## Agent skills

### Writing fragments

When a session produces a fragment-worthy moment (a leading word, a war story, a
sharp design tension, a coinage), append it to `.scratch/writing/fragments.md` in
this repo (create `.scratch/` if absent). Aim for prose, not decision-record
voice.

### Workflow routing

Most skills in `~/.agents/skills/` set `disable-model-invocation: true`, so you **cannot** load them yourself. Only the user can run them as `/skill:<name>`. When a task matches one, name the exact command and hand off explicitly.

The Model Tier is bound to the `/skill:<name>` command, not to skill loading: it does **not** change when a skill is referenced or read, and the `subagent` tool never changes the main chat's tier. When you finish planning and it is time to implement, say so plainly — e.g. "Run `/skill:implement` to proceed; that also switches to the balanced model." Do not just say "proceed" and start writing code on the planning model. A one-off tier override can be appended to any message as `@deep`, `@balanced`, or `@fast`.

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical triage roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### Research & facts

- **Fetched, not remembered.** A claim about what a service or tool can do (or its current limits) is a doc lookup made at the moment of dependence; memory only forms the hypothesis.
- Tool docs: **context7**; landscape, comparisons, news: **exa** (both deferred MCP). Prefer CLI for anything a CLI does. See `docs/agents/mcp-guide.md`.

### CLI tools & sandbox runtime

- Always use `fd` instead of `find`, `rg` instead of `grep -r`, and `jq` instead of inline Python/Node JSON scripts. Never scan `/` outside the workspace.
- `bun` is installed via `mise` under `~/.local/share/mise/installs/`. If a sandboxed command cannot find `bun`, do not search the filesystem for it; run unsandboxed (`BypassSandbox: true`).
