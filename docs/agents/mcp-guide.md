# MCP Server Rules

How and when to configure Model Context Protocol (MCP) servers in this harness.

## Rule 1: Never replace a good CLI with an MCP server

If a tool has a standard CLI (`git`, `rg`, `fd`, `jq`, `bun`, `cargo`, `zig`, `ghc`, `docker`, `sqlite3`, `psql`, `gh`), use `bash` directly. CLI tools cost zero prompt tokens and models are heavily trained on their flags.

## Rule 2: Always use `exposure: "deferred"`

Pi 1.5.0 includes built-in MCP support (`builtin:mcp` + `builtin:tool-search` + `builtin:codemode`). Do **not** install `pi-mcp-adapter`. Set `"exposure": "deferred"` on every server in `mcp.json` so tool schemas stay out of the system prompt until loaded on demand via `tool_search`.

## Rule 3: When to add an MCP server

1. **Global Web Search & Library Docs (`~/.pi/agent/mcp.json`)**:
   - Already configured globally via `exa` (`https://mcp.exa.ai/mcp`) and `context7` (`@upstash/context7-mcp`).
   - **Which for what:** `context7` for official library/tool docs (resolve the library id first); `exa` for landscape, comparisons, and news.
2. **Browser / DOM Inspection (Project-local `.pi/mcp.json`)**:
   - Add `@playwright/mcp` only in frontend web projects where the agent must click elements, inspect computed styles, or read browser console errors.
3. **SaaS APIs without a clean local CLI (Project-local `.pi/mcp.json`)**:
   - Add remote OAuth MCP endpoints (e.g., Sentry, Figma, Linear, Notion) to `.pi/mcp.json` and authenticate with `/mcp login <server>`.
