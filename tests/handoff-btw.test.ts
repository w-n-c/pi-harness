import { describe, expect, test } from "bun:test";
import handoffExtension, { buildBtwPrompt } from "../agent/extensions/handoff.ts";

describe("/btw ephemeral side-question command", () => {
	test("registers both /handoff and /btw commands and builds a side-question prompt without mutating session entries", () => {
		const commands = new Map<string, any>();
		const pi = {
			registerCommand(name: string, def: any) {
				commands.set(name, def);
			},
		};

		handoffExtension(pi as any);
		expect(commands.has("handoff")).toBe(true);
		expect(commands.has("btw")).toBe(true);

		const prompt = buildBtwPrompt("User: working on parser\nAssistant: added token stream", "What is a lexer?");
		expect(prompt).toContain("working on parser");
		expect(prompt).toContain("What is a lexer?");
	});
});
