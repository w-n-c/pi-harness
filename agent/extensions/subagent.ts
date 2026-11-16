import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSkillModelsConfig, type ModelTier, resolveTierForProvider } from "./skill-router.ts";

const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const READ_ONLY_TOOLS = "read,grep,find,ls,tool_search";
const READ_WRITE_TOOLS = "read,write,edit,bash,grep,find,ls,tool_search";

export interface SubagentTaskInput {
	prompt: string;
	tier?: ModelTier;
	model?: string;
	effort?: string;
	mode?: "read-only" | "read-write";
}

export interface SubagentRunResult {
	response: string;
	exitCode: number | null;
	stderr: string;
}

export interface SubagentOptions {
	configPath?: string;
	/** Spawn hook, overridable in tests. Receives full argv after the `pi` binary. */
	runPiSubagent?: (
		args: string[],
		prompt: string,
		signal?: AbortSignal,
	) => Promise<SubagentRunResult>;
}

/**
 * Resolves the executable used to spawn a child Pi. Mirrors Pi's own example so we
 * work under a compiled binary, a `bun/node <script.ts>` invocation, or a plain `pi`
 * on PATH. Never hardcodes a provider-specific CLI — the child inherits this harness.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function defaultRunPiSubagent(
	args: string[],
	prompt: string,
	signal?: AbortSignal,
): Promise<SubagentRunResult> {
	const invocation = getPiInvocation(args);
	return new Promise<SubagentRunResult>((resolve, reject) => {
		const proc = spawn(invocation.command, invocation.args, {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		let stderr = "";
		let buffer = "";
		let finalText = "";
		let settled = false;
		let timedOut = false;

		const killTimer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, DEFAULT_TIMEOUT_MS);

		if (signal) {
			if (signal.aborted) proc.kill("SIGTERM");
			else signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
		}

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			fn();
		};

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message as Message | undefined;
			if (!message || message.role !== "assistant") return;
			const parts = Array.isArray(message.content) ? message.content : [];
			const text = parts
				.filter((p: any) => p.type === "text" && p.text)
				.map((p: any) => p.text)
				.join("\n");
			if (text.trim()) finalText = text;
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString("utf8");
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(() => {
				if (timedOut) {
					reject(new Error(`Subagent exceeded ${DEFAULT_TIMEOUT_MS}ms and was killed.`));
					return;
				}
				resolve({ response: finalText.trim(), exitCode: code, stderr: stderr.trim() });
			});
		});
		proc.on("error", (error) => {
			finish(() => reject(error));
		});

		proc.stdin.write(prompt);
		proc.stdin.end();
	});
}

export default function subagentExtension(pi: ExtensionAPI, options: SubagentOptions = {}) {
	const runSubagent = options.runPiSubagent ?? defaultRunPiSubagent;

	const TierSchema = Type.Optional(
		Type.Union([Type.Literal("deep"), Type.Literal("balanced"), Type.Literal("fast")], {
			description: "Vendor-agnostic Model Tier (defaults to the configured default tier)",
		}),
	);
	const ModeSchema = Type.Optional(
		Type.Union([Type.Literal("read-only"), Type.Literal("read-write")], {
			description: "Execution mode: 'read-only' (default) or 'read-write'",
		}),
	);
	const TaskProperties = {
		tier: TierSchema,
		model: Type.Optional(Type.String({ description: "Explicit model override" })),
		effort: Type.Optional(Type.String({ description: "Explicit reasoning effort override (low|medium|high)" })),
		mode: ModeSchema,
	};

	const TaskSchema = Type.Object({
		prompt: Type.String({ description: "Self-contained task prompt for the isolated subagent" }),
		...TaskProperties,
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate one or more isolated fresh-context tasks (research, parallel code-review, or ticket implementation) to child Pi processes. The child inherits the active provider and runs with this harness's extensions and guardrails.",
		promptSnippet: "Delegate isolated single or parallel tasks to fresh-context subagents",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Task prompt for a single subagent run" })),
			...TaskProperties,
			tasks: Type.Optional(
				Type.Array(TaskSchema, {
					description: `Parallel subagent tasks (up to ${MAX_CONCURRENCY} run concurrently)`,
				}),
			),
		}),
		async execute(_toolCallId, params: any, signal, _onUpdate, ctx: ExtensionContext) {
			const config = loadSkillModelsConfig(options.configPath);
			const activeProvider: string | undefined = ctx?.model?.provider;
			const taskList: SubagentTaskInput[] =
				Array.isArray(params.tasks) && params.tasks.length > 0 ? params.tasks : [{ ...params }];

			async function runOneTask(task: SubagentTaskInput, index: number) {
				const tier: ModelTier = task.tier ?? config.defaultTier;
				const tierTarget = activeProvider ? resolveTierForProvider(config, activeProvider, tier) : undefined;
				const resolvedModel = task.model ?? tierTarget?.model;
				const resolvedEffort = task.effort ?? tierTarget?.effort;
				const mode = task.mode ?? "read-only";

				const args: string[] = ["--mode", "json", "-p", "--no-session"];
				if (resolvedModel) args.push("--model", resolvedModel);
				if (resolvedEffort) args.push("--thinking", resolvedEffort);
				args.push("--tools", mode === "read-write" ? READ_WRITE_TOOLS : READ_ONLY_TOOLS);

				const result = await runSubagent(args, task.prompt, signal);
				return { index, resolvedModel: resolvedModel ?? "(inherited)", mode, ...result };
			}

			const results: Array<Awaited<ReturnType<typeof runOneTask>>> = [];
			for (let i = 0; i < taskList.length; i += MAX_CONCURRENCY) {
				const batch = taskList.slice(i, i + MAX_CONCURRENCY);
				const batchResults = await Promise.all(batch.map((t, idx) => runOneTask(t, i + idx)));
				results.push(...batchResults);
			}

			const formatted =
				results.length === 1
					? results[0].response
					: results
							.map(
								(r) =>
									`### Subagent ${r.index + 1} (${r.resolvedModel}, ${r.mode})\n\n${r.response}${
										r.stderr ? `\n\n<stderr>\n${r.stderr}\n</stderr>` : ""
									}`,
							)
							.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: formatted || "(subagent returned no text output)" }],
				details: { count: results.length },
			};
		},
	});
}
