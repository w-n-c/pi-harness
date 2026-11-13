import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESTRUCTIVE_BASH_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "git push", regex: /\bgit\s+push\b|['"]push['"]/i },
	{ label: "git reset --hard", regex: /\bgit\s+reset\s+--hard\b|['"]--hard['"]/i },
	{ label: "git clean -f", regex: /\bgit\s+clean\s+-[a-z]*f/i },
	{ label: "git branch -D", regex: /\bgit\s+branch\s+-D\b/ },
	{ label: "git checkout/restore .", regex: /\bgit\s+(checkout|restore)\s+\.(?:\s|$|;|&|\|)/ },
	{ label: "recursive delete (rm -rf)", regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive)\b/ },
	{ label: "inline script recursive delete", regex: /\b(shutil\.rmtree|fs\.rmSync|fs\.rmdirSync|os\.remove)\b/ },
	{ label: "sudo / privilege escalation", regex: /\bsudo\b/ },
];

const PROTECTED_PATH_REGEX =
	/(?:^|[/"'\s(])(\.env(?:\.[a-zA-Z0-9._-]+)?|auth\.json|mcp-auth\.json|oauth_creds\.json|\.ssh\/id_[a-z0-9_]+)(?:$|["')\s])/i;

const SECRET_CONTENT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "Private Key Block", regex: /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PRIVATE) .*?PRIVATE KEY-----/ },
	{ label: "Anthropic API Key", regex: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/ },
	{ label: "OpenAI API Key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
	{ label: "Google API Key", regex: /\bAIzaSy[A-Za-z0-9_-]{33}\b/ },
];

function isProtectedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	const base = path.basename(normalized);
	if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example" && base !== ".env.template")) {
		return true;
	}
	if (base === "auth.json" || base === "mcp-auth.json" || base === "oauth_creds.json") {
		return true;
	}
	if (normalized.includes("/.ssh/") || normalized.startsWith("~/.ssh/")) {
		return true;
	}
	return false;
}

export default function guardrailsExtension(pi: ExtensionAPI) {
	const shimDir = path.join(os.homedir(), ".pi", "agent", "guardrails-bin");

	pi.on("tool_call", async (event, ctx) => {
		const { toolName, input } = event;

		if (toolName === "read" || toolName === "write" || toolName === "edit") {
			const rawPath = String(input.path ?? input.file_path ?? "");
			if (rawPath && isProtectedPath(rawPath)) {
				return {
					block: true,
					reason: `SECURITY POLICY: Access to protected credential file '${rawPath}' is blocked. Do NOT attempt to read or modify this file via alternative commands or scripts; ask the user instead.`,
				};
			}
		}

		if (toolName === "write" || toolName === "edit") {
			const textToScan = String(input.content ?? input.newText ?? input.replacement ?? "");
			for (const secret of SECRET_CONTENT_PATTERNS) {
				if (secret.regex.test(textToScan)) {
					const approved = ctx.hasUI
						? await ctx.ui.confirm(
								"Hardcoded Secret Detected",
								`Detected possible ${secret.label} in ${input.path ?? "file"}. Allow write?`,
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
			const command = String(input.command ?? "");

			if (PROTECTED_PATH_REGEX.test(command) && !command.includes(".env.example")) {
				return {
					block: true,
					reason:
						"SECURITY POLICY: Command references a protected credential file (.env, auth.json, or .ssh key). Do NOT attempt to read or modify this file via alternative commands or scripts; ask the user instead.",
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
					input.command = `export PATH="${shimDir}:$PATH" PI_ALLOW_DANGEROUS_GIT=1; ${command}`;
					return undefined;
				}
			}

			if (!command.includes(shimDir)) {
				input.command = `export PATH="${shimDir}:$PATH"; ${command}`;
			}
		}

		return undefined;
	});
}
