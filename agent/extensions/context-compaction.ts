/**
 * Dynamic Compaction Threshold
 *
 * Pi's built-in threshold is `contextTokens > contextWindow - compaction.reserveTokens`,
 * with a static reserve. A static reserve means the boundary moves whenever the
 * model window changes. This extension computes the boundary directly instead,
 * so switching models keeps the working boundary in the same place.
 *
 * Interactive sessions (TUI/RPC) compact once the projected context exceeds
 * 180k. Non-interactive runs are exempt: subagents are spawned as `--mode json`,
 * so the research agent (and any other subagent or print run) can pull in a
 * large document set without hitting the 180k boundary. Those runs still compact
 * via Pi's built-in near-window threshold.
 *
 * Built-in compaction stays enabled as the safety net (near-window threshold and
 * overflow recovery); this extension only adds an earlier trigger for interactive
 * sessions. Keep `compaction.reserveTokens` at its default so the safety net
 * sits just below the window.
 *
 * IMPORTANT: `ctx.compact()` is the *manual* compaction entry point. It calls
 * `session.abort()` first and never resumes the interrupted run. Firing it while
 * the agent loop is still live (turn_end / agent_end) races the next turn and
 * kills it mid-stream — that is not a compaction bug, it is what manual
 * compaction is specified to do. So the trigger only runs from `agent_settled`,
 * when the run is fully done and the internal abort is a no-op. Trade-off: the
 * boundary is enforced between runs, not mid-run; a single long run can overshoot
 * 180k and is compacted once it settles.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Working-context boundary for interactive sessions. */
const TARGET_TOKENS = 180_000;
/** Headroom kept for the response when the window is smaller than TARGET_TOKENS. */
const MIN_RESERVE = 16_384;

export default function (pi: ExtensionAPI) {
	let compacting = false;

	const thresholdFor = (contextWindow: number): number =>
		Math.min(TARGET_TOKENS, Math.max(0, contextWindow - MIN_RESERVE));

	const maybeCompact = (ctx: ExtensionContext) => {
		// Exempt subagents (`--mode json`), print, and other non-interactive runs.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (compacting) return;

		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) return;
		if (usage.tokens <= thresholdFor(usage.contextWindow)) return;

		compacting = true;
		if (ctx.hasUI) {
			ctx.ui.notify("Context boundary reached — compacting", "info");
		}
		ctx.compact({
			onComplete: () => {
				compacting = false;
			},
			onError: (error) => {
				compacting = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Auto-compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	pi.on("session_start", () => {
		compacting = false;
	});
	// `agent_settled` is the first point where the run is genuinely idle, so the
	// abort() inside ctx.compact() cannot cancel live work.
	pi.on("agent_settled", (_event, ctx) => maybeCompact(ctx));
}
