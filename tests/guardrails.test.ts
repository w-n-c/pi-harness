import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import guardrailsExtension from "../agent/extensions/guardrails.ts";

function createFakeGuardrailHarness(confirmResult = false) {
	const toolCallHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
	const toolResultHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
	const inputHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
	const confirmPrompts: Array<{ title: string; message: string }> = [];

	const ctx = {
		hasUI: true,
		ui: {
			async confirm(title: string, message: string) {
				confirmPrompts.push({ title, message });
				return confirmResult;
			},
			notify() {},
		},
	};

	const pi = {
		on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
			if (event === "tool_call") toolCallHandlers.push(handler);
			if (event === "tool_result") toolResultHandlers.push(handler);
			if (event === "input") inputHandlers.push(handler);
			return () => {};
		},
	};

	return {
		pi: pi as any,
		ctx,
		confirmPrompts,
		async runToolCall(toolName: string, input: Record<string, any>) {
			const event = { toolName, toolCallId: "tc-1", input };
			for (const handler of toolCallHandlers) {
				const res = await handler(event, ctx);
				if (res) return { result: res, mutatedInput: event.input };
			}
			return { result: undefined, mutatedInput: event.input };
		},
		async recordToolResult(toolName: string, isError: boolean) {
			for (const handler of toolResultHandlers) {
				await handler({ toolName, toolCallId: "tc-1", isError }, ctx);
			}
		},
		async resetTurnWithUserInput(text = "next prompt") {
			for (const handler of inputHandlers) {
				await handler({ text, source: "interactive" }, ctx);
			}
		},
	};
}

describe("Seam 2: Lifecycle Guardrails (Layer 1 Hook + Layer 2 OS Git Shim)", () => {
	test("allows safe bash and file operations without prompting", async () => {
		const harness = createFakeGuardrailHarness(false);
		guardrailsExtension(harness.pi);

		const bashRes = await harness.runToolCall("bash", { command: "rg 'ModelTier' agent/ && git status" });
		expect(bashRes.result).toBeUndefined();
		expect(harness.confirmPrompts).toHaveLength(0);

		const readRes = await harness.runToolCall("read", { path: "GLOSSARY.md" });
		expect(readRes.result).toBeUndefined();
	});

	test("catches chained and inline-script destructive commands, terminating turn when user declines", async () => {
		const harness = createFakeGuardrailHarness(false);
		guardrailsExtension(harness.pi);

		const chainedGit = await harness.runToolCall("bash", {
			command: "git status && git reset --hard HEAD~1",
		});
		expect(harness.confirmPrompts.length).toBe(1);
		expect(chainedGit.result?.block).toBe(true);
		expect(chainedGit.result?.terminate).toBe(true);
		expect(chainedGit.result?.reason).toContain("Do NOT attempt to work around");

		const inlinePy = await harness.runToolCall("bash", {
			command: `python3 -c "import shutil; shutil.rmtree('/tmp/build')"`,
		});
		expect(inlinePy.result?.block).toBe(true);
		expect(inlinePy.result?.terminate).toBe(true);
	});

	test("injects PI_ALLOW_DANGEROUS_GIT=1 when user approves destructive git command", async () => {
		const harness = createFakeGuardrailHarness(true);
		guardrailsExtension(harness.pi);

		const approved = await harness.runToolCall("bash", {
			command: "git push origin main",
		});
		expect(approved.result).toBeUndefined();
		expect(approved.mutatedInput.command).toContain("PI_ALLOW_DANGEROUS_GIT=1");
	});

	test("hard-blocks reading or modifying protected credential paths across read, write, edit, and bash", async () => {
		const harness = createFakeGuardrailHarness(true);
		guardrailsExtension(harness.pi);

		const readEnv = await harness.runToolCall("read", { path: ".env.local" });
		expect(readEnv.result?.block).toBe(true);
		expect(readEnv.result?.reason).toContain("Do NOT attempt to read or modify");

		const readAuth = await harness.runToolCall("read", { path: "/home/w-n-c/.pi/agent/auth.json" });
		expect(readAuth.result?.block).toBe(true);

		const bashCatEnv = await harness.runToolCall("bash", {
			command: `python3 -c "print(open('.env').read())"`,
		});
		expect(bashCatEnv.result?.block).toBe(true);
	});

	test("gates writing hardcoded private keys or secret tokens in write/edit", async () => {
		const harness = createFakeGuardrailHarness(false);
		guardrailsExtension(harness.pi);

		const writeKey = await harness.runToolCall("write", {
			path: "src/config.ts",
			content: "const key = `-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA...`;",
		});
		expect(writeKey.result?.block).toBe(true);
		expect(writeKey.result?.terminate).toBe(true);
	});

	test("Layer 2 OS-level PATH git shim blocks deep subprocess git push/reset while allowing safe git and approved calls", () => {
		const shimDir = path.resolve("/home/w-n-c/.pi/agent/guardrails-bin");
		const envWithShim = {
			...process.env,
			PATH: `${shimDir}:${process.env.PATH}`,
		};

		const safeGit = spawnSync("python3", ["-c", "import subprocess; subprocess.run(['git', 'status'], check=True)"], {
			env: envWithShim,
			encoding: "utf8",
		});
		expect(safeGit.status).toBe(0);

		const deepBlockedPush = spawnSync(
			"python3",
			["-c", "import subprocess; subprocess.run(['git', 'push', 'origin', 'main'], check=True)"],
			{
				env: envWithShim,
				encoding: "utf8",
			},
		);
		expect(deepBlockedPush.status).not.toBe(0);
		expect(deepBlockedPush.stderr).toContain("BLOCKED by Pi git guardrail");

		const deepBlockedReset = spawnSync(
			"python3",
			["-c", "import subprocess; subprocess.run(['git', 'reset', '--hard'], check=True)"],
			{
				env: envWithShim,
				encoding: "utf8",
			},
		);
		expect(deepBlockedReset.status).not.toBe(0);
		expect(deepBlockedReset.stderr).toContain("BLOCKED by Pi git guardrail");
	});

	test("trips circuit breaker with terminate: true after 3 consecutive tool failures and resets on success or user input", async () => {
		const harness = createFakeGuardrailHarness(true);
		guardrailsExtension(harness.pi);

		await harness.recordToolResult("bash", true);
		await harness.recordToolResult("bash", true);
		expect((await harness.runToolCall("bash", { command: "ls" })).result).toBeUndefined();

		await harness.recordToolResult("bash", true);
		const tripped = await harness.runToolCall("bash", { command: "ls" });
		expect(tripped.result?.block).toBe(true);
		expect(tripped.result?.terminate).toBe(true);
		expect(tripped.result?.reason).toContain("CIRCUIT BREAKER");

		await harness.resetTurnWithUserInput("try again");
		expect((await harness.runToolCall("bash", { command: "ls" })).result).toBeUndefined();
	});
});
