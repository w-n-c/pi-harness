## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical triage roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

### MCP servers

Built-in MCP with `"exposure": "deferred"` only; prefer standard CLI tools over MCP. See `docs/agents/mcp-guide.md`.

### CLI tools & sandbox runtime

- Always use `fd` instead of `find`, `rg` instead of `grep -r`, and `jq` instead of inline Python/Node JSON scripts. Never scan `/` outside the workspace.
- `bun` is installed via `mise` under `~/.local/share/mise/installs/`. If a sandboxed command cannot find `bun`, do not search the filesystem for it; run unsandboxed (`BypassSandbox: true`).

