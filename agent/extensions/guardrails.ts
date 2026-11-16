import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CONSECUTIVE_FAILURES = 3;

const DESTRUCTIVE_BASH_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "git push", regex: /\bgit\s+push\b|['"]push['"]/i },
	{ label: "git reset --hard", regex: /\bgit\s+reset\s+--hard\b|['"]--hard['"]/i },
	{ label: "git clean -f", regex: /\bgit\s+clean\s+-[a-z]*f/i },
	{ label: "git branch -D", regex: /\bgit\s+branch\s+-D\b/ },
	{ label: "git stash drop/clear", regex: /\bgit\s+stash\s+(?:-\S+\s+)*(?:drop|clear)\b/ },
	{ label: "git checkout/restore .", regex: /\bgit\s+(checkout|restore)\s+\.(?:\s|$|;|&|\|)/ },
	{ label: "recursive delete (rm -rf)", regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b/ },
	{ label: "inline script recursive delete", regex: /\b(shutil\.rmtree|fs\.rmSync|fs\.rmdirSync|os\.remove)\b/ },
	{ label: "sudo / privilege escalation", regex: /\bsudo\b/ },
];

const PROTECTED_PATH_TOKEN_REGEX =
	/(?:^|[/"'\s(])(\.env(?:\.[a-zA-Z0-9._-]+)?|auth\.json|mcp-auth\.json|oauth_creds\.json|\.ssh\/id_[a-z0-9_]+)(?:$|["')\s])/i;

const SECRET_CONTENT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "Private Key Block", regex: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) .*?PRIVATE KEY-----/ },
	{
		label: "Hardcoded Credential Assignment (*_KEY / *_SECRET / *_TOKEN / *_PASSWORD)",
		regex:
			/\b[A-Za-z0-9_]*(?:API_?KEY|SECRET(?:_?KEY)?|ACCESS_?TOKEN|AUTH_?TOKEN|PRIVATE_?KEY|CLIENT_?SECRET|PASSWORD)\b\s*["']?\s*[:=]\s*["'](?!\$|\$\{|https?:\/\/|your[-_]|example|dummy|test|todo|replace)[A-Za-z0-9_./+=-]{16,}["']/i,
	},
	{
		label: "Known Provider Token Prefix",
		regex: /\b(?:sk-ant-api03-[A-Za-z0-9_-]{20,}|sk-(?:proj-|live-)?[A-Za-z0-9]{24,}|AIzaSy[A-Za-z0-9_-]{33}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
	},
];

function stripSafeEnvTemplates(text: string): string {
	return text.replace(/\.env\.(example|template)\b/gi, "ENV_TEMPLATE_SAFE");
}

function isProtectedPath(filePath: string): boolean {
	const sanitized = stripSafeEnvTemplates(filePath.replace(/\\/g, "/"));
	const base = path.basename(sanitized);
	if (base === ".env" || base.startsWith(".env.")) {
		return true;
	}
	if (base === "auth.json" || base === "mcp-auth.json" || base === "oauth_creds.json") {
		return true;
	}
	if (sanitized.includes("/.ssh/") || sanitized.startsWith("~/.ssh/")) {
		return true;
	}
	return false;
}

export default function guardrailsExtension(pi: ExtensionAPI) {
	const shimDir = path.join(os.homedir(), ".pi", "agent", "guardrails-bin");
	let consecutiveFailures = 0;

	pi.on("input", async () => {
		consecutiveFailures = 0;
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.promptGuidelines.push(
			"Always use 'fd' instead of 'find', 'rg' instead of 'grep', and 'jq' instead of inline python/node JSON scripts.",
		);
	});

	pi.on("tool_result", async (event) => {
		if (event.isError) {
			consecutiveFailures += 1;
		} else {
			consecutiveFailures = 0;
		}
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			consecutiveFailures = 0;
			return {
				block: true,
				terminate: true,
				reason: `CIRCUIT BREAKER: ${MAX_CONSECUTIVE_FAILURES} consecutive tool calls failed in this turn. Stopping execution to prevent a retry loop—summarize the failure and ask the user how to proceed.`,
			};
		}

		const { toolName } = event;

		if (toolName === "read" || toolName === "write" || toolName === "edit") {
			const rawPath = String(event.input.path ?? "");
			if (rawPath && isProtectedPath(rawPath)) {
				return {
					block: true,
					reason: `SECURITY POLICY: Access to protected credential file '${rawPath}' is blocked. Do NOT attempt to read or modify this file via alternative commands or scripts; ask the user instead.`,
				};
			}
		}

		if (toolName === "write" || toolName === "edit") {
			// `event` is a discriminated union that also includes CustomToolCallEvent
			// (input: Record<string, unknown>), so TS cannot narrow it by toolName alone.
			// Narrow explicitly to the two concrete write-shaped inputs.
			const writeInput = event.input as { path: string; content: string } | { path: string; edits: { oldText: string; newText: string }[] };
			const textToScan =
				"content" in writeInput
					? writeInput.content
					: writeInput.edits.map((e) => `${e.newText}\n${e.oldText}`).join("\n");
			for (const secret of SECRET_CONTENT_PATTERNS) {
				if (secret.regex.test(textToScan)) {
					const approved = ctx.hasUI
						? await ctx.ui.confirm(
								"Hardcoded Secret Detected",
								`Detected possible ${secret.label} in ${writeInput.path}. Allow write?`,
							)
						: false;
					if (!approved) {
						return {
							block: true,
							terminate: true,
							reason: `SECURITY POLICY: Blocked writing hardcoded ${secret.label}. Do NOT attempt to work around this check; use environment variables instead.`,
						};
					}
				}
			}
		}

		if (toolName === "bash") {
			const command = String(event.input.command ?? "");
			const sanitizedForPathCheck = stripSafeEnvTemplates(command);

			if (PROTECTED_PATH_TOKEN_REGEX.test(sanitizedForPathCheck)) {
				return {
					block: true,
					reason:
						"SECURITY POLICY: Command references a protected credential file (.env, auth.json, or .ssh key). Do NOT attempt to read or modify this file via alternative commands or scripts; ask the user instead.",
				};
			}

			if (/(?:^|[;&|]\s*)find\s+/.test(command) && !command.includes("node_modules")) {
				return {
					block: true,
					reason:
						"PERFORMANCE GUARDRAIL: Do not use 'find' (it traverses node_modules and floods context). Use 'fd' (e.g. 'fd --max-depth 4') or 'rg --files' instead, which automatically respect .gitignore.",
				};
			}

			if (/(?:^|[;&]\s*)\b(?:e?grep)\s+-[a-zA-Z]*[rR]/.test(command)) {
				return {
					block: true,
					reason:
						"PERFORMANCE GUARDRAIL: Do not use recursive 'grep -r' (it traverses node_modules/.git and is slow). Use 'rg' (ripgrep) instead, which automatically respects .gitignore.",
				};
			}

			if (/\b(?:python3?\s+-c\s+.*?\bjson\.load|node\s+-e\s+.*?\bJSON\.parse)\b/s.test(command)) {
				return {
					block: true,
					reason:
						"PERFORMANCE GUARDRAIL: Use 'jq' instead of inline python/node scripts to inspect or parse JSON files.",
				};
			}

			for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
				if (pattern.regex.test(command)) {
					const approved = ctx.hasUI
						? await ctx.ui.confirm(
								`Destructive Operation (${pattern.label})`,
								`Allow command?\n\n${command}`,
							)
						: false;
					if (!approved) {
						return {
							block: true,
							terminate: true,
							reason: `User declined confirmation for destructive operation (${pattern.label}). Do NOT attempt to work around this refusal with another command or script; wait for user instructions.`,
						};
					}
					event.input.command = `export PATH="${shimDir}:$PATH" PI_ALLOW_DANGEROUS_GIT=1; ${command}; unset PI_ALLOW_DANGEROUS_GIT`;
					return undefined;
				}
			}

			if (command.includes(shimDir)) {
				// Clear any bypass a previous approval left in the persistent shell, so
				// the escape hatch never outlives the one command it was granted for.
				event.input.command = `unset PI_ALLOW_DANGEROUS_GIT 2>/dev/null; ${command}`;
			} else {
				event.input.command = `unset PI_ALLOW_DANGEROUS_GIT 2>/dev/null; export PATH="${shimDir}:$PATH"; ${command}`;
			}
		}

		return undefined;
	});
}
