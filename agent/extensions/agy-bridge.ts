import { spawn } from "node:child_process";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSkillModelsConfig, type ModelTier, resolveTierForProvider } from "./skill-router.ts";

const SMART_ZONE_CONTEXT_WINDOW = 160000;
const MAX_CONCURRENCY = 4;

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface AgyBridgeOptions {
	configPath?: string;
	runAgyStream?: (args: string[], signal?: AbortSignal) => Promise<AsyncIterable<string> | string[]>;
	runAgySubagent?: (
		args: string[],
		signal?: AbortSignal,
	) => Promise<{ response: string; usage?: Record<string, number> }>;
}

const AGY_MODELS = [
	{ id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", reasoning: true },
	{ id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", reasoning: true },
	{ id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", reasoning: true },
	{ id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", reasoning: true },
	{ id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", reasoning: true },
	{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", reasoning: true },
	{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", reasoning: false },
	{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", reasoning: false },
	{ id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", reasoning: true },
	{ id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", reasoning: true },
	{ id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", reasoning: true },
];

export function buildAgyArgs(modelId: string, effort?: string, mode: "plan" | "auto" = "plan", prompt = ""): string[] {
	const suffixMatch = modelId.match(/-(low|medium|high|xhigh|max)$/i);
	const resolvedEffort = suffixMatch ? suffixMatch[1].toLowerCase() : effort;

	const args = ["--output-format", "stream-json", "--disable-slash-commands", "--mode", mode, "--model", modelId];
	if (resolvedEffort && !suffixMatch) {
		args.push("--effort", resolvedEffort === "minimal" ? "low" : resolvedEffort);
	}
	args.push("-p", prompt);
	return args;
}

function extractMessageText(msg: Message): string {
	const rawContent = (msg as any).content;
	if (typeof rawContent === "string") return rawContent;
	if (!Array.isArray(rawContent)) return "";

	const parts: string[] = [];
	for (const block of rawContent) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		} else if (block.type === "toolCall") {
			parts.push(
				`<pi_tool_call>${JSON.stringify({ name: block.name, arguments: block.arguments })}</pi_tool_call>`,
			);
		}
	}
	return parts.join("\n");
}

export function buildAgyBridgePrompt(systemPrompt: string | undefined, tools: Tool[], messages: Message[]): string {
	const sections: string[] = [];

	sections.push(
		[
			"You are operating as the reasoning model inside the Pi coding agent harness.",
			"IMPORTANT PROTOCOL:",
			"1. Do NOT invoke any internal Antigravity tools (such as view_file, run_command, replace_file_content, list_dir, etc.).",
			"2. When you want Pi to execute one of its declared tools, output one or more XML blocks in this exact format:",
			'   <pi_tool_call>{"name":"<tool_name>","arguments":{...}}</pi_tool_call>',
			"3. When replying to the user with no tool call needed, reply with normal Markdown text.",
		].join("\n"),
	);

	if (systemPrompt) {
		sections.push(`<pi_system_prompt>\n${systemPrompt}\n</pi_system_prompt>`);
	}

	if (tools.length > 0) {
		const serializedTools = tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		sections.push(`<pi_available_tools>\n${JSON.stringify(serializedTools)}\n</pi_available_tools>`);
	}

	const transcriptLines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "system") continue;
		if (msg.role === "user") {
			transcriptLines.push(`[USER]\n${extractMessageText(msg)}`);
		} else if (msg.role === "assistant") {
			transcriptLines.push(`[ASSISTANT]\n${extractMessageText(msg)}`);
		} else if (msg.role === "toolResult") {
			const resultText = extractMessageText(msg);
			transcriptLines.push(
				`[TOOL_RESULT toolName="${(msg as any).toolName ?? ""}" isError="${Boolean((msg as any).isError)}"]\n${resultText}`,
			);
		}
	}

	sections.push(`<pi_conversation>\n${transcriptLines.join("\n\n")}\n</pi_conversation>`);
	return sections.join("\n\n");
}

export function parseResponseSegments(rawResponse: string): {
	textBlocks: string[];
	toolCalls: ParsedToolCall[];
} {
	const toolCalls: ParsedToolCall[] = [];
	const toolRegex = /<pi_tool_call>\s*([\s\S]*?)\s*<\/pi_tool_call>/g;

	const stripped = rawResponse.replace(toolRegex, (_full, jsonPayload: string) => {
		try {
			const parsed = JSON.parse(jsonPayload.trim());
			if (parsed && typeof parsed.name === "string") {
				toolCalls.push({
					name: parsed.name,
					arguments: (parsed.arguments as Record<string, unknown>) ?? {},
				});
			}
		} catch {
			// Ignore malformed JSON tool call block
		}
		return "";
	});

	const trimmedText = stripped.trim();
	return {
		textBlocks: trimmedText ? [trimmedText] : [],
		toolCalls,
	};
}

async function* defaultSpawnAgyLines(args: string[], signal?: AbortSignal): AsyncGenerator<string> {
	const proc = spawn("agy", args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (signal) {
		signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	}

	let buffer = "";
	for await (const chunk of proc.stdout) {
		buffer += chunk.toString("utf8");
		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = buffer.slice(0, newlineIdx).trim();
			buffer = buffer.slice(newlineIdx + 1);
			if (line.startsWith("{")) {
				yield line;
			}
			newlineIdx = buffer.indexOf("\n");
		}
	}
	if (buffer.trim().startsWith("{")) {
		yield buffer.trim();
	}
}

async function defaultRunAgySubagent(
	args: string[],
	signal?: AbortSignal,
): Promise<{ response: string; usage?: Record<string, number> }> {
	let finalResponse = "";
	let finalUsage: Record<string, number> | undefined;

	for await (const line of defaultSpawnAgyLines(args, signal)) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.event === "result" && parsed.result) {
				finalResponse = String(parsed.result.response ?? "").trim();
				finalUsage = parsed.result.usage;
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return { response: finalResponse, usage: finalUsage };
}

export default function agyBridgeExtension(pi: ExtensionAPI, options: AgyBridgeOptions = {}) {
	const runStream = options.runAgyStream ?? defaultSpawnAgyLines;
	const runSubagent = options.runAgySubagent ?? defaultRunAgySubagent;

	function streamAgy(
		model: Model<Api>,
		context: TranscriptContext,
		streamOpts?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const transcript = collapseSystemMessages(context);
		const systemPrompt = getCurrentSystemPrompt(transcript.messages);
		const tools = getCurrentTools(transcript.messages);

		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: Date.now(),
			};

			try {
				const prompt = buildAgyBridgePrompt(systemPrompt, tools, transcript.messages);
				const effort = streamOpts?.reasoning && streamOpts.reasoning !== "off" ? streamOpts.reasoning : "medium";
				const args = buildAgyArgs(model.id, effort, "plan", prompt);

				stream.push({ type: "start", partial: output });

				let finalResponseText = "";
				const lines = await runStream(args, streamOpts?.signal);
				for await (const line of lines) {
					let eventObj: any;
					try {
						eventObj = JSON.parse(line);
					} catch {
						continue;
					}

					if (eventObj.event === "result" && eventObj.result) {
						if (eventObj.result.status === "ERROR") {
							throw new Error(eventObj.result.error || "agy returned status ERROR");
						}
						finalResponseText = String(eventObj.result.response ?? "");
						const u = eventObj.result.usage;
						if (u) {
							output.usage.input = u.input_tokens || 0;
							output.usage.output = u.output_tokens || 0;
							output.usage.cacheRead = u.cache_read_tokens || 0;
							output.usage.totalTokens = u.total_tokens || output.usage.input + output.usage.output;
						}
					}
				}

				const { textBlocks, toolCalls } = parseResponseSegments(finalResponseText);

				for (const text of textBlocks) {
					const idx = output.content.length;
					output.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: idx, partial: output });
					stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: output });
					stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
				}

				let tcCounter = 1;
				for (const tc of toolCalls) {
					const idx = output.content.length;
					const toolCallBlock = {
						type: "toolCall" as const,
						id: `agy_tc_${tcCounter++}`,
						name: tc.name,
						arguments: tc.arguments,
					};
					output.content.push(toolCallBlock);
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolCallBlock, partial: output });
				}

				output.stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end();
			} catch (err) {
				output.stopReason = streamOpts?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = err instanceof Error ? err.message : String(err);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	}

	pi.registerProvider("agy", {
		name: "Antigravity CLI (Gemini Pro Subscription)",
		baseUrl: "http://localhost",
		apiKey: "agy-cli",
		api: "agy-cli-bridge",
		models: AGY_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: SMART_ZONE_CONTEXT_WINDOW,
			maxTokens: 32768,
		})),
		streamSimple: streamAgy,
	});

	const TaskSchema = Type.Object({
		prompt: Type.String({ description: "Self-contained task prompt for the isolated subagent" }),
		tier: Type.Optional(
			Type.Union([Type.Literal("deep"), Type.Literal("balanced"), Type.Literal("fast")], {
				description: "Vendor-agnostic Model Tier (defaults to 'balanced')",
			}),
		),
		model: Type.Optional(Type.String({ description: "Explicit model override" })),
		effort: Type.Optional(Type.String({ description: "Explicit reasoning effort override (low|medium|high)" })),
		mode: Type.Optional(
			Type.Union([Type.Literal("read-only"), Type.Literal("read-write")], {
				description: "Execution mode: 'read-only' (default) or 'read-write'",
			}),
		),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate one or more isolated fresh-context tasks (research, parallel code-review, or ticket implementation) to child agent processes.",
		promptSnippet: "Delegate isolated single or parallel tasks to fresh-context subagents",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Task prompt for a single subagent run" })),
			tier: Type.Optional(Type.Union([Type.Literal("deep"), Type.Literal("balanced"), Type.Literal("fast")])),
			model: Type.Optional(Type.String()),
			effort: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("read-write")])),
			tasks: Type.Optional(
				Type.Array(TaskSchema, {
					description: "Parallel subagent tasks (up to 4 run concurrently)",
				}),
			),
		}),
		async execute(_toolCallId, params: any, signal) {
			const config = loadSkillModelsConfig(options.configPath);
			const taskList: Array<{
				prompt: string;
				tier?: ModelTier;
				model?: string;
				effort?: string;
				mode?: "read-only" | "read-write";
			}> = Array.isArray(params.tasks) && params.tasks.length > 0 ? params.tasks : [{ ...params }];

			async function runOneTask(task: (typeof taskList)[number], index: number) {
				const tier: ModelTier = task.tier ?? config.defaultTier;
				const tierTarget = resolveTierForProvider(config, "agy", tier);
				const resolvedModel = task.model ?? tierTarget?.model ?? "gemini-4-argon-medium";
				const resolvedEffort = task.effort ?? tierTarget?.effort ?? "medium";
				const agyMode = task.mode === "read-write" ? "auto" : "plan";

				const args = buildAgyArgs(resolvedModel, String(resolvedEffort), agyMode, task.prompt);

				const result = await runSubagent(args, signal);
				return { index, resolvedModel, mode: task.mode ?? "read-only", response: result.response };
			}

			const results: Array<{ index: number; resolvedModel: string; mode: string; response: string }> = [];
			for (let i = 0; i < taskList.length; i += MAX_CONCURRENCY) {
				const batch = taskList.slice(i, i + MAX_CONCURRENCY);
				const batchResults = await Promise.all(batch.map((t, idx) => runOneTask(t, i + idx)));
				results.push(...batchResults);
			}

			const formatted =
				results.length === 1
					? results[0].response
					: results
							.map((r) => `### Subagent ${r.index + 1} (${r.resolvedModel}, ${r.mode})\n\n${r.response}`)
							.join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: formatted }],
				details: { count: results.length },
			};
		},
	});
}
