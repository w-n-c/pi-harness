import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelTier = "deep" | "balanced" | "fast";

export interface TierTarget {
	model: string;
	effort: ThinkingLevel;
}

export interface SkillModelsConfig {
	defaultTier: ModelTier;
	providers: Record<string, Record<ModelTier, TierTarget>>;
	skills: Record<string, ModelTier>;
}

export interface SkillRouterOptions {
	configPath?: string;
	skillsDirs?: string[];
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "skill-models.json");
const DEFAULT_SKILLS_DIRS = [
	path.join(os.homedir(), ".pi", "agent", "skills"),
	path.join(os.homedir(), ".agents", "skills"),
];

export function loadSkillModelsConfig(configPath = DEFAULT_CONFIG_PATH): SkillModelsConfig {
	const raw = fs.readFileSync(configPath, "utf8");
	return JSON.parse(raw) as SkillModelsConfig;
}

export function resolveTierForProvider(
	config: SkillModelsConfig,
	provider: string,
	tier: ModelTier,
): TierTarget | undefined {
	return config.providers[provider]?.[tier];
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function readSkillBody(skillName: string, skillsDirs: string[]): string | undefined {
	for (const dir of skillsDirs) {
		const candidate = path.join(dir, skillName, "SKILL.md");
		if (fs.existsSync(candidate)) {
			return stripFrontmatter(fs.readFileSync(candidate, "utf8"));
		}
	}
	return undefined;
}

function extractChainedSkills(skillBody: string): string[] {
	if (!/Call the Skill tool/i.test(skillBody)) return [];
	const matches = [...skillBody.matchAll(/"([a-z0-9-]+)"/gi)];
	return matches.map((m) => m[1]);
}

function parseInlineOverride(text: string): {
	cleanedText: string;
	overrideTier?: ModelTier;
	overrideModelId?: string;
} {
	const tokenRegex = /(?:^|\s)@(deep|balanced|fast|[a-z0-9][a-z0-9._-]+)(?=\s|$)/i;
	const match = text.match(tokenRegex);
	if (!match) return { cleanedText: text };

	const token = match[1].toLowerCase();
	if (token.includes("/") || token.includes(".")) {
		return { cleanedText: text };
	}

	const cleanedText = text.replace(tokenRegex, " ").replace(/\s+/g, " ").trim();
	if (token === "deep" || token === "balanced" || token === "fast") {
		return { cleanedText, overrideTier: token };
	}
	return { cleanedText, overrideModelId: token };
}

export default function skillRouterExtension(pi: ExtensionAPI, options: SkillRouterOptions = {}) {
	const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
	const skillsDirs = options.skillsDirs ?? DEFAULT_SKILLS_DIRS;
	let locked = false;

	async function applyTierOrModel(
		ctx: ExtensionContext,
		config: SkillModelsConfig,
		target: { tier?: ModelTier; modelId?: string },
	) {
		const activeProvider = ctx.model?.provider;
		if (!activeProvider) return;
		if (target.modelId) {
			const explicitModel =
				ctx.modelRegistry.find(activeProvider, target.modelId) ??
				ctx.modelRegistry.getAll().find((m) => m.id === target.modelId);
			if (explicitModel) {
				await pi.setModel(explicitModel);
			}
			return;
		}

		if (target.tier) {
			const resolved = resolveTierForProvider(config, activeProvider, target.tier);
			if (!resolved) return;
			const modelObj = ctx.modelRegistry.find(activeProvider, resolved.model);
			if (!modelObj) return;
			await pi.setModel(modelObj);
			// Only override thinking when the tier declares an effort. Passing undefined would
			// reach clampThinkingLevel(), which has no index for it and silently falls back to the
			// model's lowest level ('off' on models that support it) — eager thinking-off by accident.
			if (resolved.effort) {
				pi.setThinkingLevel(resolved.effort);
			}
		}
	}

	pi.registerCommand("tier", {
		description: "Set or lock the active Model Tier: /tier <deep|balanced|fast|lock|auto>",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const config = loadSkillModelsConfig(configPath);
			if (arg === "lock") {
				locked = true;
				ctx.ui.notify("Model tier auto-switching locked.", "info");
				return;
			}
			if (arg === "auto" || arg === "unlock") {
				locked = false;
				ctx.ui.notify("Model tier auto-switching enabled.", "info");
				return;
			}
			if (arg === "deep" || arg === "balanced" || arg === "fast") {
				await applyTierOrModel(ctx, config, { tier: arg });
				ctx.ui.notify(`Switched to '${arg}' model tier.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /tier <deep|balanced|fast|lock|auto>", "warning");
		},
	});

	pi.on("input", async (event, ctx) => {
		const config = loadSkillModelsConfig(configPath);
		const { cleanedText, overrideTier, overrideModelId } = parseInlineOverride(event.text);

		const skillMatch = cleanedText.match(/^\/skill:([a-z0-9-]+)(?:\s|$)/i);
		const skillName = skillMatch?.[1]?.toLowerCase();

		if (overrideTier || overrideModelId) {
			await applyTierOrModel(ctx, config, { tier: overrideTier, modelId: overrideModelId });
		} else if (!locked && skillName) {
			const tier = config.skills[skillName] ?? config.defaultTier;
			await applyTierOrModel(ctx, config, { tier });
		}

		let finalPrompt = cleanedText;
		if (skillName) {
			const body = readSkillBody(skillName, skillsDirs);
			if (body) {
				const chained = extractChainedSkills(body);
				const expandedBlocks: string[] = [];
				for (const childSkill of chained) {
					const childBody = readSkillBody(childSkill, skillsDirs);
					if (childBody) {
						expandedBlocks.push(`<chained_skill name="${childSkill}">\n${childBody}\n</chained_skill>`);
					}
				}
				if (expandedBlocks.length > 0) {
					finalPrompt = `${cleanedText}\n\n${expandedBlocks.join("\n\n")}`;
				}
			}
		}

		if (finalPrompt !== event.text) {
			return { action: "transform", text: finalPrompt };
		}
		return { action: "continue" };
	});
}
