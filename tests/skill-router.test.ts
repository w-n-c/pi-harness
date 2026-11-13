import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import skillRouterExtension from "../agent/extensions/skill-router.ts";

function createFakePi(activeProvider = "agy") {
	const inputHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	const selectedModels: Array<{ provider: string; id: string }> = [];
	const thinkingLevels: string[] = [];
	const notifications: string[] = [];

	const catalog = [
		{ provider: "agy", id: "gemini-4-argon-high" },
		{ provider: "agy", id: "gemini-4-argon-medium" },
		{ provider: "agy", id: "gemini-3.8-flash-high" },
		{ provider: "agy", id: "claude-opus-5-5-high" },
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
	];

	const ctx = {
		model: { provider: activeProvider, id: "gemini-4-argon-medium" },
		modelRegistry: {
			find(provider: string, id: string) {
				return catalog.find((m) => m.provider === provider && m.id === id);
			},
			getAll() {
				return catalog;
			},
		},
		ui: {
			notify(msg: string) {
				notifications.push(msg);
			},
		},
	};

	const pi = {
		on(event: string, handler: (event: any, ctx: any) => Promise<any>) {
			if (event === "input") inputHandlers.push(handler);
			return () => {};
		},
		registerCommand(name: string, def: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, def);
		},
		async setModel(model: { provider: string; id: string }) {
			selectedModels.push(model);
			ctx.model = model;
			return true;
		},
		setThinkingLevel(level: string) {
			thinkingLevels.push(level);
		},
	};

	return {
		pi: pi as any,
		ctx,
		selectedModels,
		thinkingLevels,
		notifications,
		commands,
		async sendInput(text: string) {
			let current = text;
			for (const handler of inputHandlers) {
				const res = await handler({ text: current, source: "interactive" }, ctx);
				if (res?.action === "transform" && typeof res.text === "string") {
					current = res.text;
				}
			}
			return current;
		},
	};
}

describe("Seam 1: Skill & Model Tier Router", () => {
	test("routes /skill:<name> to configured Model Tier for active provider and expands chained Skill tool calls", async () => {
		const tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-test-"));
		fs.mkdirSync(path.join(tmpSkillsDir, "grill-with-docs"), { recursive: true });
		fs.mkdirSync(path.join(tmpSkillsDir, "grilling"), { recursive: true });
		fs.mkdirSync(path.join(tmpSkillsDir, "domain-modeling"), { recursive: true });

		fs.writeFileSync(
			path.join(tmpSkillsDir, "grill-with-docs", "SKILL.md"),
			`---\nname: grill-with-docs\ndescription: Grill with docs\n---\nCall the Skill tool twice, for "grilling" and "domain-modeling".\n`,
		);
		fs.writeFileSync(
			path.join(tmpSkillsDir, "grilling", "SKILL.md"),
			`---\nname: grilling\ndescription: Grilling primitive\n---\nWork the design tree in rounds.`,
		);
		fs.writeFileSync(
			path.join(tmpSkillsDir, "domain-modeling", "SKILL.md"),
			`---\nname: domain-modeling\ndescription: Domain modeling\n---\nUpdate GLOSSARY.md inline.`,
		);

		const harness = createFakePi("agy");
		skillRouterExtension(harness.pi, {
			skillsDirs: [tmpSkillsDir],
		});

		const output = await harness.sendInput("/skill:grill-with-docs @[start_point.md]");

		expect(harness.selectedModels).toEqual([{ provider: "agy", id: "gemini-4-argon-high" }]);
		expect(harness.thinkingLevels).toEqual(["high"]);
		expect(output).toContain("Work the design tree in rounds.");
		expect(output).toContain("Update GLOSSARY.md inline.");
	});

	test("applies inline @<tier> and @<model> overrides and strips override token from prompt", async () => {
		const harness = createFakePi("agy");
		skillRouterExtension(harness.pi);

		const out1 = await harness.sendInput("/skill:implement @deep build the feature");
		expect(harness.selectedModels.at(-1)).toEqual({ provider: "agy", id: "gemini-4-argon-high" });
		expect(harness.thinkingLevels.at(-1)).toBe("high");
		expect(out1.startsWith("/skill:implement build the feature")).toBe(true);
		expect(out1).not.toContain("@deep");

		const out2 = await harness.sendInput("quick check on this file @fast");
		expect(harness.selectedModels.at(-1)).toEqual({ provider: "agy", id: "gemini-3.8-flash-high" });
		expect(harness.thinkingLevels.at(-1)).toBe("low");
		expect(out2).toBe("quick check on this file");
	});

	test("supports /tier lock and /tier auto commands to control automatic switching", async () => {
		const harness = createFakePi("agy");
		skillRouterExtension(harness.pi);

		const tierCmd = harness.commands.get("tier");
		expect(tierCmd).toBeDefined();

		await tierCmd!.handler("lock", harness.ctx);
		await harness.sendInput("/skill:grill-with-docs plan this");
		expect(harness.selectedModels).toHaveLength(0);

		await tierCmd!.handler("auto", harness.ctx);
		await harness.sendInput("/skill:grill-with-docs plan this");
		expect(harness.selectedModels).toEqual([{ provider: "agy", id: "gemini-4-argon-high" }]);
	});
});
