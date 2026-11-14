import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	DynamicBorder,
	getMarkdownTheme,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.`;

const BTW_SYSTEM_PROMPT = `You are answering an ephemeral side question (/btw) from the user during an active coding session.
Answer concisely and directly using the provided conversation context if relevant.
Your response is shown in a temporary overlay and is NOT recorded in the main conversation history.`;

export function buildBtwPrompt(conversationText: string, question: string): string {
	if (!conversationText.trim()) {
		return question;
	}
	return `## Current Session Context (Read-Only)\n\n${conversationText}\n\n## Side Question (/btw)\n\n${question}`;
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

export function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
}

async function showBtwOverlay(question: string, answer: string, ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui") return;

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(`💬 /btw: ${question}`)), 1, 0));
		container.addChild(new Markdown(answer, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to dismiss (not saved to session context)"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
}

export default function handoffExtension(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask an ephemeral side question without adding to session context: /btw <question>",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <side question>", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			const conversationText = messages.length > 0 ? serializeConversation(convertToLlm(messages)) : "";
			const promptText = buildBtwPrompt(conversationText, question);

			const answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Asking /btw (off-the-record)...");
				loader.onAbort = () => done(null);

				const userMessage: Message = {
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				};

				ctx.modelRegistry
					.complete(
						ctx.model!,
						{ systemPrompt: BTW_SYSTEM_PROMPT, messages: [userMessage] },
						{
							signal: loader.signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					)
					.then((response) => {
						if (response.stopReason === "aborted") {
							done(null);
							return;
						}
						const text = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						done(text);
					})
					.catch((err) => {
						done(`Error: ${err instanceof Error ? err.message : String(err)}`);
					});

				return loader;
			});

			if (answer === null) {
				ctx.ui.notify("/btw cancelled", "info");
				return;
			}

			await showBtwOverlay(question, answer, ctx);
		},
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);
			const currentSessionFile = ctx.sessionManager.getSessionFile();

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await ctx.modelRegistry.complete(
						ctx.model!,
						{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
						{
							signal: loader.signal,
							cacheRetention: "none",
							sessionId: uuidv7(),
						},
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
					.then(done)
					.catch((err) => {
						console.error("Handoff generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
