/**
 * Context Footer
 *
 * Replaces the built-in footer so the stats line shows the raw single-turn
 * context size instead of `N%/window`. The number is colored:
 *   <= 140k green, <= 180k yellow, > 180k red.
 *
 * Everything else mirrors Pi's built-in footer: cwd/branch/session name,
 * cumulative ↑input ↓output RcacheRead WcacheWrite + cache hit + cost, model +
 * thinking level, and extension statuses. The built-in footer's virtual-model
 * routing arrow and subscription marker are not reproduced.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const GREEN_MAX = 140_000;
const YELLOW_MAX = 180_000;

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Usage carried by an entry, if any. Loosely typed on purpose. */
function entryUsage(entry: SessionEntry): any {
	if (entry.type === "usage") return entry.usage;
	if (entry.type === "message") {
		if (entry.message.role === "assistant") return entry.message.usage;
		if (entry.message.role === "toolResult") return entry.message.usage;
		return undefined;
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") return entry.usage;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			let cacheKey = "";
			let cached:
				| {
						totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
						cacheHitRate: number | undefined;
						contextTokens: number | null;
						contextWindow: number;
						autoCompact: boolean;
				  }
				| undefined;

			const getStats = () => {
				const leafId = ctx.sessionManager.getLeafId();
				const model = ctx.model;
				const key = `${leafId}:${model?.provider}/${model?.id}`;
				if (cached && key === cacheKey) return cached;

				const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				let cacheHitRate: number | undefined;
				for (const entry of ctx.sessionManager.getEntries()) {
					const usage = entryUsage(entry);
					if (!usage) continue;
					totals.input += usage.input;
					totals.output += usage.output;
					totals.cacheRead += usage.cacheRead;
					totals.cacheWrite += usage.cacheWrite;
					totals.cost += usage.cost.total;
					if (entry.type === "message" && entry.message.role === "assistant") {
						const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
						cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
					}
				}

				const context = ctx.getContextUsage();
				cached = {
					totals,
					cacheHitRate,
					contextTokens: context?.tokens ?? null,
					contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
					autoCompact: pi.getSettings().compaction?.enabled ?? true,
				};
				cacheKey = key;
				return cached;
			};

			return {
				dispose: unsubscribe,
				invalidate() {
					cached = undefined;
					cacheKey = "";
				},
				render(width: number): string[] {
					const { totals, cacheHitRate, contextTokens, contextWindow, autoCompact } = getStats();
					const model = ctx.model;

					let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const parts: string[] = [];
					if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cacheHitRate !== undefined) {
						parts.push(`CH${cacheHitRate.toFixed(1)}%`);
					}
					if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

					// Raw single-turn context size in place of the built-in "N%/window".
					const auto = autoCompact ? " (auto)" : "";
					if (contextTokens == null) {
						parts.push(theme.fg("dim", `?${auto}`));
					} else {
						const color = contextTokens <= GREEN_MAX ? "success" : contextTokens <= YELLOW_MAX ? "warning" : "error";
						parts.push(theme.fg(color, `${formatTokens(contextTokens)}${auto}`));
					}

					let statsLeft = parts.join(" ");

					const modelName = model?.id || "no-model";
					let right = modelName;
					if (model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					}
					if (footerData.getAvailableProviderCount() > 1 && model) {
						right = `(${model.provider}) ${right}`;
					}

					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const rightWidth = visibleWidth(right);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightWidth <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + right;
					} else {
						const available = width - statsLeftWidth - 2;
						if (available > 0) {
							const truncated = truncateToWidth(right, available, "");
							statsLine =
								statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) + truncated;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	});
}
