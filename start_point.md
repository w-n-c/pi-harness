I want to establish a sovereign, fully-featured coding agent harness built on Pi (pi.dev) so I am not dependent on
proprietary platforms (like Antigravity / Claude Code) for complex workflows.

My setup:
- Running on Linux, Bun / environment for web dev but I am a java cloud engineer by training. I want to explore a lot of other languages (zig and/or rust, haskell, smalltalk) and have a goalof building a hybrid lisp/machine ometa dsl engine operating system on top of wasm. Also work through educational materials like nand2tetris, an ai grad course, sicp, taocp.
- I'm currently on a gemini pro subscription so my agent calls have to pipe through agy but once my discounted subscription is up I want a vendor agnostic setup
- Using Matt Pollock's skills to develop my content.

What I need designed and scaffolded:
1. Pi Package & Extension Architecture: A dedicated repository or configuration directory (e.g., `~/.pi/` or a standalone
repo) for custom Pi extensions.
2. Feature-Rich Capabilities to Port:
   - Stateful multi-step workflows (equivalent to Matt Pocock's /grilling, /to-spec, /to-tickets, /implement).
   - Pre-tool / post-tool execution hooks (safety guardrails, secret detection, auto-test passes).
   - Context inspection and scratchpad / session logging tools.
3. Step-by-step setup: From installing Pi, configuring keys, writing the first custom TypeScript extensions, to verifying a complex design-to-implementation run directly inside the terminal.
4.  We may need to add some skills to adjust for working through educational content and DS&A problems.

Guidelines:
1. Keep the always-on toolset minimal:
Stick to pi's 4 core tools (read, write, edit, bash). Don't add specialized grep/find/LSP tools unless you measure a concrete win over bash (rg, fd, tsc).
2. Load workflows on demand, not in the system prompt:
Put specialized workflows (TDD, code review, spec implementation) in on-demand slash commands or markdown skills loaded only when invoked, rather than baking them into global instructions.
3. Add only 2–3 high-leverage extensions:
    • Fresh-context Subagent / agy Delegator: Offloads noisy codebase exploration or parallel ticket implementation into isolated child runs so your main pi context stays clean.
    • Lifecycle Guardrails Hook: Hook tool/commit events to run repo checks (like scripts/git-guardrails.sh or bun test) deterministically in code instead of spending prompt tokens
    reminding the model.
    • Session / Context Hygiene: Rely on pi's built-in /tree and /fork branching rather than heavy auto-summarization plugins.
4. Gate heavy integrations (MCP, browser, external APIs) per-session:
If you use MCP or Composio toolkits, load them only in the specific project/profile that needs them—never globally.
