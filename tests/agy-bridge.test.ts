import { describe, expect, test } from "bun:test";
import agyBridgeExtension, {
	buildAgyArgs,
	buildAgyBridgePrompt,
	encodeAgyStdinMessage,
	MAX_AGY_PROMPT_BYTES,
	parseResponseSegments,
} from "../agent/extensions/agy-bridge.ts";

function createFakeAgyPi() {
	let registeredProvider: { name: string; config: any } | undefined;
	let registeredTool: any;

	const pi = {
		registerProvider(name: string, config: any) {
			registeredProvider = { name, config };
		},
		registerTool(def: any) {
			registeredTool = def;
		},
	};

	return {
		pi: pi as any,
		getProvider: () => registeredProvider,
		getTool: () => registeredTool,
	};
}

describe("Seam 3: agy Provider Bridge & Subagent Tool", () => {
	test("registers 'agy' provider with 160k Smart Zone contextWindow cap", () => {
		const harness = createFakeAgyPi();
		agyBridgeExtension(harness.pi);

		const provider = harness.getProvider();
		expect(provider).toBeDefined();
		expect(provider!.name).toBe("agy");
		expect(provider!.config.models.length).toBeGreaterThanOrEqual(6);
		for (const model of provider!.config.models) {
			expect(model.contextWindow).toBe(160000);
		}
	});

	test("serializes TranscriptContext with Pi tools and parses <pi_tool_call> blocks into Pi toolUse responses", async () => {
		const prompt = buildAgyBridgePrompt(
			"You are Pi.",
			[
				{
					name: "bash",
					description: "Run bash command",
					parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as any,
				},
			],
			[{ role: "user", content: [{ type: "text", text: "List files" }], timestamp: 1 } as any],
		);

		expect(prompt).toContain("You are Pi.");
		expect(prompt).toContain('"name":"bash"');
		expect(prompt).toContain("List files");

		const parsed = parseResponseSegments(
			`Let me check the directory.\n<pi_tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</pi_tool_call>`,
		);
		expect(parsed.textBlocks).toEqual(["Let me check the directory."]);
		expect(parsed.toolCalls).toEqual([
			{
				name: "bash",
				arguments: { command: "ls -la" },
			},
		]);
	});

	test("annotates toolResult with totalLines and compacts oldest toolResults so prompt stays under agy 175KB limit without truncating newest read", () => {
		const oldLargeOutput = Array.from({ length: 1200 }, (_, i) => `old-line-${i}: ${"x".repeat(120)}`).join("\n");
		const newestBoxHtml = Array.from({ length: 372 }, (_, i) => `<div data-line="${i}">box content</div>`).join("\n");

		const prompt = buildAgyBridgePrompt(
			"System prompt",
			[],
			[
				{ role: "user", content: [{ type: "text", text: "Start review" }], timestamp: 1 } as any,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "old.txt" } }],
					timestamp: 2,
				} as any,
				{
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: oldLargeOutput }],
					timestamp: 3,
				} as any,
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc2", name: "read", arguments: { path: ".scratch/every-layout/box.html" } }],
					timestamp: 4,
				} as any,
				{
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: newestBoxHtml }],
					timestamp: 5,
				} as any,
			],
		);

		expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_AGY_PROMPT_BYTES);
		expect(prompt).toContain('totalLines="372"');
		expect(prompt).toContain('<div data-line="371">box content</div>');
		expect(prompt).toContain("older tool output compacted");
	});

	test("streams NDJSON from agy subprocess via stdin stream-json (avoiding argv E2BIG) and emits Pi toolCall events", async () => {
		const harness = createFakeAgyPi();
		const spawnedArgs: string[][] = [];
		const spawnedPrompts: string[] = [];

		const cliArgs = buildAgyArgs("gemini-4-argon-medium", "medium", "plan");
		expect(cliArgs).toContain("--input-format");
		expect(cliArgs[cliArgs.indexOf("--input-format") + 1]).toBe("stream-json");
		expect(cliArgs.slice(-2)).toEqual(["-p", ""]);
		expect(JSON.parse(encodeAgyStdinMessage("hello world"))).toEqual({
			event: "user",
			message: { content: "hello world" },
		});

		agyBridgeExtension(harness.pi, {
			runAgyStream: async (args, prompt) => {
				spawnedArgs.push(args);
				spawnedPrompts.push(prompt);
				return [
					JSON.stringify({
						event: "init",
						conversation_id: "conv-1",
						init: { model: "gemini-4-argon-medium" },
					}),
					JSON.stringify({
						event: " result_ignored",
					}),
					JSON.stringify({
						event: "result",
						result: {
							conversation_id: "conv-1",
							status: "SUCCESS",
							response: `Checking now.\n<pi_tool_call>{"name":"read","arguments":{"path":"GLOSSARY.md"}}</pi_tool_call>`,
							usage: {
								input_tokens: 1200,
								output_tokens: 45,
								cache_read_tokens: 100,
								total_tokens: 1345,
							},
						},
					}),
				];
			},
		});

		const provider = harness.getProvider()!;
		const model = provider.config.models[0];
		const stream = provider.config.streamSimple(
			{ ...model, provider: "agy", api: "agy-cli-bridge" },
			{
				messages: [
					{
						role: "system",
						content: "System prompt",
						tools: [{ name: "read", description: "Read file", parameters: { type: "object", properties: {} } }],
						timestamp: 1,
					},
					{
						role: "user",
						content: [{ type: "text", text: "Read GLOSSARY.md" }],
						timestamp: 2,
					},
				],
			},
			{ reasoning: "high" },
		);

		const events: any[] = [];
		for await (const ev of stream) {
			events.push(ev);
		}

		expect(spawnedArgs[0].slice(-2)).toEqual(["-p", ""]);
		expect(spawnedPrompts[0]).toContain("Read GLOSSARY.md");

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeDefined();
		expect(doneEvent.reason).toBe("toolUse");
		expect(doneEvent.message.content).toEqual([
			{ type: "text", text: "Checking now." },
			{
				type: "toolCall",
				id: "agy_tc_1",
				name: "read",
				arguments: { path: "GLOSSARY.md" },
			},
		]);
		expect(doneEvent.message.usage.input).toBe(1200);
		expect(doneEvent.message.usage.output).toBe(45);
	});

	test("subagent tool executes single and parallel tasks with tier resolution and read-only default mode", async () => {
		const harness = createFakeAgyPi();
		const calls: string[][] = [];

		agyBridgeExtension(harness.pi, {
			runAgySubagent: async (args, prompt) => {
				calls.push(args);
				return {
					response: `Completed: ${prompt}`,
					usage: { input_tokens: 500, output_tokens: 50 },
				};
			},
		});

		const tool = harness.getTool();
		expect(tool).toBeDefined();
		expect(tool.name).toBe("subagent");

		const singleRes = await tool.execute(
			"call-1",
			{ prompt: "Explore repo", tier: "fast" },
			undefined,
			undefined,
			{},
		);
		expect(calls[0]).toContain("--mode");
		expect(calls[0][calls[0].indexOf("--mode") + 1]).toBe("plan");
		expect(calls[0]).toContain("gemini-3.8-flash-high");
		expect(singleRes.content[0].text).toContain("Completed: Explore repo");

		calls.length = 0;
		const parallelRes = await tool.execute(
			"call-2",
			{
				tasks: [
					{ prompt: "Review Standards", tier: "balanced" },
					{ prompt: "Review Spec", tier: "deep", mode: "read-write" },
				],
			},
			undefined,
			undefined,
			{},
		);
		expect(calls).toHaveLength(2);
		expect(calls[0][calls[0].indexOf("--mode") + 1]).toBe("plan");
		expect(calls[1][calls[1].indexOf("--mode") + 1]).toBe("auto");
		expect(parallelRes.content[0].text).toContain("Completed: Review Standards");
		expect(parallelRes.content[0].text).toContain("Completed: Review Spec");
	});
});
