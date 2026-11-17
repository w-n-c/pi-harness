import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import subagentExtension, {
	getPiInvocation,
	prepareSubagentLog,
	resolveSubagentLogPath,
	teeToLog,
} from "../agent/extensions/subagent.ts";

function writeConfig(providers: Record<string, any>, defaultTier = "balanced") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const configPath = path.join(dir, "skill-models.json");
	fs.writeFileSync(configPath, JSON.stringify({ defaultTier, providers, skills: {} }));
	return configPath;
}

function createFakePi() {
	let registeredTool: any;
	const pi = {
		registerTool(def: any) {
			registeredTool = def;
		},
	};
	return {
		pi: pi as any,
		getTool: () => registeredTool,
	};
}

describe("Seam 4: Provider-Agnostic Subagent (child Pi process)", () => {
	test("spawns a child pi process with the tier's model and thinking level instead of a vendor CLI", async () => {
		const configPath = writeConfig({
			openrouter: {
				deep: { model: "deepseek/deepseek-v4-pro-0813", effort: "high" },
				balanced: { model: "deepseek/deepseek-v4.1-flash", effort: "low" },
				fast: { model: "deepseek/deepseek-v4.1-flash", effort: "low" },
			},
		});

		const harness = createFakePi();
		const calls: Array<{ args: string[]; prompt: string }> = [];
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args, prompt) => {
				calls.push({ args, prompt });
				return { response: `Done: ${prompt}`, exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		expect(tool.name).toBe("subagent");

		const ctx = { model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" } };
		const res = await tool.execute("call-1", { prompt: "Explore repo", tier: "deep" }, undefined, undefined, ctx);

		expect(calls).toHaveLength(1);
		expect(calls[0].args).toContain("--mode");
		expect(calls[0].args[calls[0].args.indexOf("--mode") + 1]).toBe("json");
		expect(calls[0].args).toContain("-p");
		expect(calls[0].args[calls[0].args.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-pro-0813");
		expect(calls[0].args[calls[0].args.indexOf("--thinking") + 1]).toBe("high");
		expect(calls[0].args).not.toContain("agy");
		expect(res.content[0].text).toBe("Done: Explore repo");
	});

	test("defaults to read-only tools and only escalates to write/edit/bash in read-write mode", async () => {
		const configPath = writeConfig({
			openrouter: { deep: { model: "m", effort: "high" }, balanced: { model: "m" }, fast: { model: "m" } },
		});
		const harness = createFakePi();
		const calls: string[][] = [];
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args) => {
				calls.push(args);
				return { response: "ok", exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		const ctx = { model: { provider: "openrouter" } };

		await tool.execute("c1", { prompt: "read only" }, undefined, undefined, ctx);
		const readOnlyTools = calls[0][calls[0].indexOf("--tools") + 1];
		expect(readOnlyTools).toBe("read,grep,find,ls,tool_search");
		expect(readOnlyTools).not.toContain("write");
		expect(readOnlyTools).not.toContain("bash");

		await tool.execute("c2", { prompt: "implement", mode: "read-write" }, undefined, undefined, ctx);
		const rwTools = calls[1][calls[1].indexOf("--tools") + 1];
		expect(rwTools).toContain("write");
		expect(rwTools).toContain("edit");
		expect(rwTools).toContain("bash");
	});

	test("runs parallel tasks and labels each result by model and mode", async () => {
		const configPath = writeConfig({
			openrouter: {
				deep: { model: "deep-model", effort: "high" },
				balanced: { model: "balanced-model" },
				fast: { model: "fast-model" },
			},
		});
		const harness = createFakePi();
		const calls: string[][] = [];
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args, prompt) => {
				calls.push(args);
				return { response: `Reply: ${prompt}`, exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		const res = await tool.execute(
			"c3",
			{ tasks: [{ prompt: "standards", tier: "balanced" }, { prompt: "spec", tier: "deep" }] },
			undefined,
			undefined,
			{ model: { provider: "openrouter" } },
		);

		expect(calls).toHaveLength(2);
		expect(res.content[0].text).toContain("balanced-model");
		expect(res.content[0].text).toContain("deep-model");
		expect(res.content[0].text).toContain("Reply: standards");
		expect(res.content[0].text).toContain("Reply: spec");
	});

	test("omits --model/--thinking and inherits the parent when no provider tier resolves", async () => {
		const configPath = writeConfig({ agy: { deep: { model: "gemini-4-argon-high" } } });
		const harness = createFakePi();
		const calls: string[][] = [];
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args) => {
				calls.push(args);
				return { response: "ok", exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		await tool.execute("id", { prompt: "x" }, undefined, undefined, { model: { provider: "openrouter" } });

		expect(calls[0]).not.toContain("--model");
		expect(calls[0]).not.toContain("--thinking");
	});

	test("never selects the agy CLI even when the parent provider is unknown", async () => {
		const configPath = writeConfig({});
		const harness = createFakePi();
		const calls: string[][] = [];
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args) => {
				calls.push(args);
				return { response: "ok", exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		await tool.execute("id", { prompt: "x" }, undefined, undefined, {});
		expect(Object.values(getPiInvocation(calls[0])).flat()).not.toContain("agy");
	});

	test("surfaces stderr and a non-zero exit code for a single task", async () => {
		const configPath = writeConfig({ openrouter: { balanced: { model: "m" } } });
		const harness = createFakePi();
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async () => ({ response: "partial output", exitCode: 2, stderr: "child exploded" }),
		});

		const res = await harness
			.getTool()
			.execute("c", { prompt: "x" }, undefined, undefined, { model: { provider: "openrouter" } });

		expect(res.content[0].text).toContain("partial output");
		expect(res.content[0].text).toContain("child exploded");
		expect(res.content[0].text).toContain("exit code 2");
	});

	test("does not add stderr/exit noise to a clean single task", async () => {
		const configPath = writeConfig({ openrouter: { balanced: { model: "m" } } });
		const harness = createFakePi();
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async () => ({ response: "Done: Explore repo", exitCode: 0, stderr: "" }),
		});

		const res = await harness
			.getTool()
			.execute("c", { prompt: "x" }, undefined, undefined, { model: { provider: "openrouter" } });

		expect(res.content[0].text).toBe("Done: Explore repo");
	});

	test("warns when a read-write task returns a suspiciously short final message", async () => {
		const configPath = writeConfig({ openrouter: { balanced: { model: "m" } } });
		const harness = createFakePi();
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async () => ({ response: "Done.", exitCode: 0, stderr: "" }),
		});

		const res = await harness
			.getTool()
			.execute("c", { prompt: "x", mode: "read-write" }, undefined, undefined, { model: { provider: "openrouter" } });

		expect(res.content[0].text).toContain("very short final message");
		expect(res.content[0].text).toContain("5 chars");
	});

	test("does not warn for a long read-write result or a short read-only result", async () => {
		const configPath = writeConfig({ openrouter: { balanced: { model: "m" } } });
		const harness = createFakePi();
		subagentExtension(harness.pi, {
			configPath,
			runPiSubagent: async (args) => {
				// Long for read-write, short for read-only.
				const readWrite = args[args.indexOf("--tools") + 1].includes("write");
				return { response: readWrite ? "x".repeat(300) : "Done.", exitCode: 0, stderr: "" };
			},
		});

		const tool = harness.getTool();
		const ctx = { model: { provider: "openrouter" } };
		const long = await tool.execute("c1", { prompt: "x", mode: "read-write" }, undefined, undefined, ctx);
		const shortReadOnly = await tool.execute("c2", { prompt: "x" }, undefined, undefined, ctx);

		expect(long.content[0].text).not.toContain("very short final message");
		expect(shortReadOnly.content[0].text).not.toContain("very short final message");
	});

	test("teeToLog appends chunks and never throws on bad paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-logs-"));
		const logPath = resolveSubagentLogPath(dir, new Date("2024-01-02T03:04:05.000Z"), 4242);
		expect(path.basename(logPath)).toBe("2024-01-02T03-04-05.000Z-4242.log");

		teeToLog(logPath, "hello ");
		teeToLog(logPath, Buffer.from("world"));
		expect(fs.readFileSync(logPath, "utf8")).toBe("hello world");

		expect(() => teeToLog(undefined, "x")).not.toThrow();
		expect(() => teeToLog("/nonexistent-dir-xyz/nope/a.log", "x")).not.toThrow();
	});

	test("prepareSubagentLog creates the log directory and returns a path inside it", () => {
		const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-logs-")), "nested", "subagents");
		const logPath = prepareSubagentLog(dir);

		expect(logPath).toBeDefined();
		expect(path.dirname(logPath!)).toBe(dir);
		expect(fs.existsSync(dir)).toBe(true);
	});
});
