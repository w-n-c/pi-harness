import { describe, expect, test } from "bun:test";
import agyBridgeExtension, {
	buildAgyBridgePrompt,
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

	test("streams NDJSON from agy subprocess and emits Pi toolCall events when <pi_tool_call> is returned", async () => {
		const harness = createFakeAgyPi();
		const spawnedArgs: string[][] = [];

		agyBridgeExtension(harness.pi, {
			runAgyStream: async (args) => {
				spawnedArgs.push(args);
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
			runAgySubagent: async (args) => {
				calls.push(args);
				return {
					response: `Completed: ${args.at(-1)}`,
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
