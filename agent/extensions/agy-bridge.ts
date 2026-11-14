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
// agy truncates the tail of any single USER_INPUT message at ~191,590 bytes.
// Keep our serialized bridge prompt below 175,000 bytes by compacting oldest tool results first.
export const MAX_AGY_PROMPT_BYTES = 175000;
const COMPACTED_TOOL_PREVIEW_CHARS = 1200;

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface SubagentTaskInput {
	prompt: string;
	tier?: ModelTier;
	model?: string;
	effort?: string;
	mode?: "read-only" | "read-write";
}

export interface AgyBridgeOptions {
	configPath?: string;
	runAgyStream?: (
		args: string[],
		prompt: string,
		signal?: AbortSignal,
	) => Promise<AsyncIterable<string> | string[]>;
	runAgySubagent?: (
		args: string[],
		prompt: string,
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

export function buildAgyArgs(modelId: string, effort?: string, mode: "plan" | "auto" = "plan"): string[] {
	const suffixMatch = modelId.match(/-(low|medium|high|xhigh|max)$/i);
	const resolvedEffort = suffixMatch ? suffixMatch[1].toLowerCase() : effort;

	const args = [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--disable-slash-commands",
		"--mode",
		mode,
		"--model",
		modelId,
	];
	if (resolvedEffort && !suffixMatch) {
		args.push("--effort", resolvedEffort === "minimal" ? "low" : resolvedEffort);
	}
	args.push("-p", "");
	return args;
}

export function encodeAgyStdinMessage(prompt: string): string {
	return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
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
		const compactPrompt = systemPrompt.replace(/<docs>[\s\S]*?<\/docs>\s*/g, "").trim();
		sections.push(`<pi_system_prompt>\n${compactPrompt}\n</pi_system_prompt>`);
	}

	if (tools.length > 0) {
		const serializedTools = tools.map((t) => ({
			name: t.name,
			description: t.description.split("\n\nCodemode:")[0].trim(),
			parameters: t.parameters,
		}));
		sections.push(`<pi_available_tools>\n${JSON.stringify(serializedTools)}\n</pi_available_tools>`);
	}

	const transcriptEntries: Array<{ role: string; text: string; compactText?: string }> = [];
	for (const msg of messages) {
		if (msg.role === "system") continue;
		if (msg.role === "user") {
			transcriptEntries.push({ role: "user", text: `[USER]\n${extractMessageText(msg)}` });
		} else if (msg.role === "assistant") {
			transcriptEntries.push({ role: "assistant", text: `[ASSISTANT]\n${extractMessageText(msg)}` });
		} else if (msg.role === "toolResult") {
			const resultText = extractMessageText(msg);
			const lineCount = resultText ? resultText.split("\n").length : 0;
			const toolName = (msg as any).toolName ?? "";
			const isError = Boolean((msg as any).isError);
			const header = `[TOOL_RESULT toolName="${toolName}" isError="${isError}" totalLines="${lineCount}"]`;
			const fullEntry = `${header}\n${resultText}`;
			let compactEntry = fullEntry;
			if (resultText.length > COMPACTED_TOOL_PREVIEW_CHARS * 2) {
				const head = resultText.slice(0, COMPACTED_TOOL_PREVIEW_CHARS);
				const tail = resultText.slice(-COMPACTED_TOOL_PREVIEW_CHARS);
				compactEntry = `${header}\n${head}\n...[older tool output compacted (${resultText.length} chars, ${lineCount} lines total) to preserve recent context]...\n${tail}`;
			}
			transcriptEntries.push({ role: "toolResult", text: fullEntry, compactText: compactEntry });
		}
	}

	const basePrefix = `${sections.join("\n\n")}\n\n<pi_conversation>\n`;
	const baseSuffix = `\n</pi_conversation>`;
	const baseOverheadBytes = Buffer.byteLength(basePrefix + baseSuffix, "utf8");
	const maxConversationBytes = Math.max(16000, MAX_AGY_PROMPT_BYTES - baseOverheadBytes);

	const activeTexts = transcriptEntries.map((e) => e.text);
	const joinByteLength = (items: string[]) => Buffer.byteLength(items.join("\n\n"), "utf8");

	// Step 1: Compact oldest toolResult blocks first, starting with turns prior to the latest assistant call
	if (joinByteLength(activeTexts) > maxConversationBytes) {
		let lastAssistantIdx = -1;
		for (let i = transcriptEntries.length - 1; i >= 0; i--) {
			if (transcriptEntries[i].role === "assistant") {
				lastAssistantIdx = i;
				break;
			}
		}
		const firstPassLimit = lastAssistantIdx > 0 ? lastAssistantIdx : Math.max(0, activeTexts.length - 2);
		for (let i = 0; i < firstPassLimit; i++) {
			if (transcriptEntries[i].role === "toolResult" && transcriptEntries[i].compactText) {
				activeTexts[i] = transcriptEntries[i].compactText!;
				if (joinByteLength(activeTexts) <= maxConversationBytes) break;
			}
		}
		// If still over budget, compact any remaining bulky toolResults except the newest one
		if (joinByteLength(activeTexts) > maxConversationBytes) {
			for (let i = firstPassLimit; i < activeTexts.length - 1; i++) {
				if (transcriptEntries[i].role === "toolResult" && transcriptEntries[i].compactText) {
					activeTexts[i] = transcriptEntries[i].compactText!;
					if (joinByteLength(activeTexts) <= maxConversationBytes) break;
				}
			}
		}
	}

	// Step 2: If still over budget, drop oldest entries from the front so newest tail is never truncated by agy
	while (activeTexts.length > 1 && joinByteLength(activeTexts) > maxConversationBytes) {
		activeTexts.shift();
	}

	sections.push(`<pi_conversation>\n${activeTexts.join("\n\n")}\n</pi_conversation>`);
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

async function* defaultSpawnAgyLines(args: string[], prompt: string, signal?: AbortSignal): AsyncGenerator<string> {
	const proc = spawn("agy", args, {
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (signal) {
		signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	}

	proc.stdin.write(encodeAgyStdinMessage(prompt));
	proc.stdin.end();

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

async function consumeAgyResultLines(
	lines: AsyncIterable<string> | string[],
): Promise<{ response: string; usage?: Record<string, number> }> {
	let finalResponse = "";
	let finalUsage: Record<string, number> | undefined;

	for await (const line of lines) {
		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.event === "result" && parsed.result) {
			if (parsed.result.status === "ERROR") {
				throw new Error(parsed.result.error || "agy returned status ERROR");
			}
			finalResponse = String(parsed.result.response ?? "");
			finalUsage = parsed.result.usage;
		}
	}

	return { response: finalResponse, usage: finalUsage };
}

export default function agyBridgeExtension(pi: ExtensionAPI, options: AgyBridgeOptions = {}) {
	const runStream = options.runAgyStream ?? defaultSpawnAgyLines;
	const runSubagent =
		options.runAgySubagent ??
		(async (args, prompt, signal) => {
			const result = await consumeAgyResultLines(defaultSpawnAgyLines(args, prompt, signal));
			return { response: result.response.trim(), usage: result.usage };
		});

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
				const args = buildAgyArgs(model.id, effort, "plan");

				stream.push({ type: "start", partial: output });

				const lines = await runStream(args, prompt, streamOpts?.signal);
				const { response: finalResponseText, usage } = await consumeAgyResultLines(lines);

				if (usage) {
					output.usage.input = usage.input_tokens || 0;
					output.usage.output = usage.output_tokens || 0;
					output.usage.cacheRead = usage.cache_read_tokens || 0;
					output.usage.totalTokens = usage.total_tokens || output.usage.input + output.usage.output;
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

	const TierSchema = Type.Optional(
		Type.Union([Type.Literal("deep"), Type.Literal("balanced"), Type.Literal("fast")], {
			description: "Vendor-agnostic Model Tier (defaults to 'balanced')",
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
			"Delegate one or more isolated fresh-context tasks (research, parallel code-review, or ticket implementation) to child agent processes.",
		promptSnippet: "Delegate isolated single or parallel tasks to fresh-context subagents",
		parameters: Type.Object({
			prompt: Type.Optional(Type.String({ description: "Task prompt for a single subagent run" })),
			...TaskProperties,
			tasks: Type.Optional(
				Type.Array(TaskSchema, {
					description: "Parallel subagent tasks (up to 4 run concurrently)",
				}),
			),
		}),
		async execute(_toolCallId, params: any, signal, _onUpdate, ctx: any) {
			const config = loadSkillModelsConfig(options.configPath);
			const activeProvider: string = ctx?.model?.provider ?? "agy";
			const taskList: SubagentTaskInput[] =
				Array.isArray(params.tasks) && params.tasks.length > 0 ? params.tasks : [{ ...params }];

			async function runOneTask(task: SubagentTaskInput, index: number) {
				const tier: ModelTier = task.tier ?? config.defaultTier;
				const tierTarget = resolveTierForProvider(config, activeProvider, tier);
				const defaultProviderTier = resolveTierForProvider(config, activeProvider, config.defaultTier);
				const resolvedModel = task.model ?? tierTarget?.model ?? defaultProviderTier?.model ?? "";
				const resolvedEffort = task.effort ?? tierTarget?.effort ?? "medium";
				const agyMode = task.mode === "read-write" ? "auto" : "plan";

				const args = buildAgyArgs(resolvedModel, String(resolvedEffort), agyMode);
				const result = await runSubagent(args, task.prompt, signal);
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
